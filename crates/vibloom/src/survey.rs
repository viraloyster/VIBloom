//! What a compiled Solidity contract says about itself, read from the
//! compiler's own syntax trees: who may call what, what it can be upgraded or
//! paused by, which other contracts it calls. These are facts about the code,
//! each with the line it comes from. What they mean for the protocol is a
//! person's call, so they become proposals, never nodes.
//!
//! A contract is read with everything it inherits, across files: the bases
//! are linearized as the compiler does, internal calls dispatch to the most
//! derived override, and names are resolved through the imports. Node ids are
//! only trusted inside one file, since files can come from different
//! compiler runs.

use crate::setup::entry_points;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

/// One source file as the compiler saw it.
pub struct Unit {
    /// `ast.absolutePath`: the path imports refer to it by.
    pub path: String,
    pub ast: Value,
    /// The ABI of each contract compiled from it, by contract name.
    pub abis: BTreeMap<String, Value>,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Function {
    pub name: String,
    /// Where it is defined: for an inherited function, the base's file.
    pub file: String,
    pub line: usize,
    /// The contract that defines it.
    pub contract: String,
    /// Defined in a file that is not the project's own (OpenZeppelin, Solady).
    pub library: bool,
    /// Modifiers that restrict who may call: `onlyRole(MINTER_ROLE)`, `onlyOwner`.
    pub gates: Vec<String>,
    /// Every other modifier: `nonReentrant`, `whenNotPaused`, `initializer`.
    pub others: Vec<String>,
    /// Lines of the caller checks in its body (see `own_checks`):
    /// `require(wish(src, msg.sender))`, or a call to a function that has one.
    pub checks: Vec<usize>,
    /// Code it runs writes storage with `sstore` or `tstore`.
    pub asm_store: bool,
    /// Code it runs can reach `selfdestruct`.
    pub selfdestruct: bool,
}

/// A state variable and what can change it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateVar {
    pub name: String,
    pub file: String,
    pub line: usize,
    pub contract: String,
    /// "constant" or "immutable"; empty for a variable that can change.
    pub fixed: &'static str,
    /// The entry points that write it, directly or through what they run.
    pub writers: Vec<String>,
    /// Internal functions that write it and that no entry point reaches.
    pub hooks: Vec<String>,
    /// Written by a constructor or given a value where it is declared.
    pub at_deployment: bool,
}

/// A gate and the state its caller check reads: `auth` reads `wards`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Guard {
    pub gate: String,
    pub vars: Vec<String>,
    /// The entry points that write any of `vars`.
    pub writers: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Contract {
    pub name: String,
    pub file: String,
    /// The direct bases, as written.
    pub bases: Vec<String>,
    /// Every contract it inherits from, most derived first, without itself.
    pub lineage: Vec<String>,
    /// Bases whose source was not found: what they add is not read.
    pub unresolved: Vec<String>,
    pub state: Vec<StateVar>,
    /// State-changing functions callable from outside: its own first, then
    /// the inherited ones, most derived base first.
    pub functions: Vec<Function>,
    /// State-changing functions of the ABI that the source did not explain.
    pub not_found: Vec<String>,
    /// `Type.member` of every call into another contract, with `file:line`.
    pub calls: BTreeMap<String, String>,
    /// The gate on `_authorizeUpgrade` and its `file:line`, when upgradeable.
    pub upgrade_gate: Option<(String, String)>,
    pub low_level: Vec<(String, String)>,
    /// Ether sent by `transfer`, `send` or `call{value: ...}`, by kind.
    pub sends: Vec<(String, String)>,
    /// `selfdestruct` (or `suicide`) in code it runs, by how it is written.
    pub selfdestructs: Vec<(String, String)>,
    /// Behind a proxy: it has an upgrade gate or an upgradeable base, so its
    /// constructor never writes the proxy's storage.
    pub upgradeable: bool,
    pub guards: Vec<Guard>,
    /// What its candidate ids start with: its name, and its file too when
    /// another contract of the project has the same name.
    pub key: String,
    /// The other reported contracts of the project that inherit from it.
    pub inherited_by: Vec<String>,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn items<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn type_string(v: &Value) -> &str {
    v.pointer("/typeDescriptions/typeString")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn type_id(v: &Value) -> &str {
    v.pointer("/typeDescriptions/typeIdentifier")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

// An argument as written, when it is simple enough to read at a glance.
fn arg_text(a: &Value, depth: usize) -> String {
    match s(a, "nodeType") {
        "Identifier" => s(a, "name").to_string(),
        "Literal" if !s(a, "value").is_empty() => s(a, "value").to_string(),
        "MemberAccess" => format!(
            "{}.{}",
            arg_text(a.get("expression").unwrap_or(&Value::Null), depth),
            s(a, "memberName")
        ),
        "FunctionCall" if depth > 0 => {
            let f = arg_text(a.get("expression").unwrap_or(&Value::Null), 0);
            let args: Vec<String> = items(a, "arguments")
                .iter()
                .map(|x| arg_text(x, depth - 1))
                .collect();
            format!("{f}({})", args.join(", "))
        }
        "ElementaryTypeNameExpression" => a
            .pointer("/typeName/name")
            .and_then(Value::as_str)
            .or_else(|| a.get("typeName").and_then(Value::as_str))
            .unwrap_or("...")
            .to_string(),
        _ => "...".to_string(),
    }
}

// A modifier as written, with simple arguments: `onlyRole(getRoleAdmin(role))`.
fn modifier_text(m: &Value) -> String {
    let name = m
        .pointer("/modifierName/name")
        .and_then(Value::as_str)
        .unwrap_or("?");
    let args: Vec<String> = items(m, "arguments")
        .iter()
        .map(|a| arg_text(a, 1))
        .collect();
    if args.is_empty() {
        name.to_string()
    } else {
        format!("{name}({})", args.join(", "))
    }
}

// A modifier that decides who may call, by the names every codebase uses:
// only for a modifier whose code could not be read.
fn is_gate(text: &str) -> bool {
    let name = text.split('(').next().unwrap_or(text);
    // Proxy and initialization guards check how the code runs, not who calls.
    if matches!(
        name,
        "onlyProxy" | "onlyDelegated" | "onlyInitializing" | "notDelegated"
    ) {
        return false;
    }
    let lower = name.to_lowercase();
    lower == "restricted"
        || lower.starts_with("only")
        || lower.starts_with("auth")
        || lower.starts_with("requiresauth")
        || lower.contains("role")
        || lower.contains("owner")
        || lower.contains("admin")
        || lower.contains("governance")
}

fn walk<'a>(node: &'a Value, f: &mut dyn FnMut(&'a Value)) {
    match node {
        Value::Object(map) => {
            f(node);
            for v in map.values() {
                walk(v, f);
            }
        }
        Value::Array(items) => {
            for v in items {
                walk(v, f);
            }
        }
        _ => {}
    }
}

fn node_id(v: &Value) -> Option<i64> {
    v.get("id").and_then(Value::as_i64)
}

fn referenced(v: &Value) -> Option<i64> {
    v.get("referencedDeclaration").and_then(Value::as_i64)
}

fn args_of(call: &Value) -> &[Value] {
    items(call, "arguments")
}

// The name a call is made by when it calls a plain identifier: `require(...)`.
fn callee_name(call: &Value) -> &str {
    call.get("expression")
        .filter(|e| s(e, "nodeType") == "Identifier")
        .map_or("", |e| s(e, "name"))
}

fn is_conversion(e: &Value) -> bool {
    s(e, "nodeType") == "FunctionCall"
        && (s(e, "kind") == "typeConversion"
            || e.pointer("/expression/nodeType").and_then(Value::as_str)
                == Some("ElementaryTypeNameExpression"))
}

// `address(x)` and `payable(x)` -> x.
fn unwrap_address(mut e: &Value) -> &Value {
    while is_conversion(e) && args_of(e).len() == 1 {
        let to = e.pointer("/expression/typeName");
        let name = to.and_then(|t| t.get("name")).and_then(Value::as_str);
        let old = to.and_then(Value::as_str);
        if !(name == Some("address")
            || old == Some("address")
            || type_string(e).starts_with("address"))
        {
            break;
        }
        e = &args_of(e)[0];
    }
    e
}

// `0`, `0x0`, `address(0)`.
fn is_zero(mut e: &Value) -> bool {
    while is_conversion(e) && args_of(e).len() == 1 {
        e = &args_of(e)[0];
    }
    let v = s(e, "value");
    let digits = v.strip_prefix("0x").unwrap_or(v);
    s(e, "nodeType") == "Literal" && !digits.is_empty() && digits.chars().all(|c| c == '0')
}

// The caller itself: `msg.sender`, `tx.origin`, `_msgSender()`, or a local
// (or a parameter given the caller) that holds one of them.
fn is_caller(e: &Value, who: &Who) -> bool {
    let e = unwrap_address(e);
    let on = e.pointer("/expression/name").and_then(Value::as_str);
    match s(e, "nodeType") {
        "MemberAccess" => matches!(
            (on, s(e, "memberName")),
            (Some("msg"), "sender") | (Some("tx"), "origin")
        ),
        "FunctionCall" if who.calls.contains_key(&ptr(e)) => true,
        "FunctionCall" => {
            let f = e.get("expression").unwrap_or(&Value::Null);
            matches!(
                if s(f, "nodeType") == "MemberAccess" {
                    s(f, "memberName")
                } else {
                    s(f, "name")
                },
                "_msgSender" | "msgSender"
            )
        }
        "Identifier" => referenced(e).is_some_and(|id| who.aliases.contains(&id)),
        _ => false,
    }
}

// A call into another contract that may change state: the compiler types
// it `external` without `view` or `pure`. Without type information it is
// not known to be one.
fn changes_other_contract(call: &Value) -> bool {
    if s(call, "nodeType") != "FunctionCall" {
        return false;
    }
    let mut f = call.get("expression").unwrap_or(&Value::Null);
    while s(f, "nodeType") == "FunctionCallOptions" {
        f = f.get("expression").unwrap_or(&Value::Null);
    }
    let Some(rest) = type_id(f).strip_prefix("t_function_external_") else {
        return false;
    };
    !matches!(
        rest.split('$').next().unwrap_or(rest),
        "view" | "pure" | "constant"
    )
}

// Whether a condition depends on who the caller is. An amount compared with
// `<` or `>` (`balanceOf[msg.sender] >= wad`) and a caller compared with the
// zero address say nothing about who may call. Neither does the caller handed
// to a state-changing call into another contract
// (`require(gem.transferFrom(msg.sender, ...))`): it asks that contract to
// act, not whether the caller may. A `view` or `pure` one (`hasRole(r,
// msg.sender)`) answers the question, so it counts.
fn uses_caller(e: &Value, who: &Who) -> bool {
    match e {
        Value::Array(items) => items.iter().any(|x| uses_caller(x, who)),
        Value::Object(map) => {
            if is_caller(e, who) {
                return true;
            }
            if changes_other_contract(e) {
                return false;
            }
            // A bool computed from the caller still counts: the helper may
            // only pass it on in assembly (`either(x, wish(u, msg.sender))`).
            if who.handed.contains(&ptr(e)) {
                return e.get("expression").is_some_and(|f| uses_caller(f, who))
                    || args_of(e).iter().any(|a| {
                        (!is_caller(a, who) || type_string(a) == "bool") && uses_caller(a, who)
                    });
            }
            if s(e, "nodeType") == "BinaryOperation" {
                let l = e.get("leftExpression").unwrap_or(&Value::Null);
                let r = e.get("rightExpression").unwrap_or(&Value::Null);
                match s(e, "operator") {
                    "<" | ">" | "<=" | ">=" => return false,
                    "==" | "!="
                        if (is_caller(l, who) && is_zero(r))
                            || (is_caller(r, who) && is_zero(l)) =>
                    {
                        return false;
                    }
                    _ => {}
                }
            }
            map.values().any(|x| uses_caller(x, who))
        }
        _ => false,
    }
}

// The whole condition compares the caller itself with zero:
// `require(msg.sender == address(0))` lets only the chain's own VM through
// (Celo). The zero exclusion in `uses_caller` is for values the caller only
// passed on, such as a parameter that a sanity check tests.
fn caller_vs_zero(cond: &Value) -> bool {
    let none = Who::default();
    match s(cond, "nodeType") {
        "TupleExpression" => match items(cond, "components") {
            [one] => caller_vs_zero(one),
            _ => false,
        },
        "UnaryOperation" if s(cond, "operator") == "!" => {
            caller_vs_zero(cond.get("subExpression").unwrap_or(&Value::Null))
        }
        "BinaryOperation" if matches!(s(cond, "operator"), "==" | "!=") => {
            let l = cond.get("leftExpression").unwrap_or(&Value::Null);
            let r = cond.get("rightExpression").unwrap_or(&Value::Null);
            (is_caller(l, &none) && is_zero(r)) || (is_caller(r, &none) && is_zero(l))
        }
        _ => false,
    }
}

// Adds to `who` the locals of a body that stand for the caller: locals
// assigned exactly from it, or bools computed from it.
fn caller_aliases(body: &Value, who: &mut Who) {
    let mut is_bool: BTreeMap<i64, bool> = BTreeMap::new();
    let mut from: Vec<(i64, &Value)> = Vec::new();
    walk(body, &mut |x| match s(x, "nodeType") {
        "VariableDeclarationStatement" => {
            let decls: Vec<&Value> = items(x, "declarations").iter().collect();
            if let [d] = decls.as_slice()
                && let Some(id) = node_id(d)
            {
                is_bool.insert(id, type_string(d) == "bool");
                if let Some(init) = x.get("initialValue").filter(|v| v.is_object()) {
                    from.push((id, init));
                }
            }
        }
        "Assignment" if s(x, "operator") == "=" => {
            if let (Some(id), Some(rhs)) = (
                x.get("leftHandSide")
                    .filter(|l| s(l, "nodeType") == "Identifier")
                    .and_then(referenced),
                x.get("rightHandSide"),
            ) {
                from.push((id, rhs));
            }
        }
        _ => {}
    });
    loop {
        let before = who.aliases.len();
        for (id, e) in &from {
            let Some(b) = is_bool.get(id) else { continue };
            if !who.aliases.contains(id) && (is_caller(e, who) || (*b && uses_caller(e, who))) {
                who.aliases.insert(*id);
            }
        }
        if who.aliases.len() == before {
            return;
        }
    }
}

/// Whether a result only excludes callers when a check passes on it being
/// true, and on it being false.
type Excludes = [bool; 2];

/// A function, and which of its parameters hold the caller.
type Tainted = (Ptr, Vec<usize>);

/// What stands for the caller in one body: locals that hold it (see
/// `caller_aliases`), and calls to internal code whose result is computed
/// from it (see `Ctx::returns_caller`), each with whether that result only
/// excludes callers when a check passes on it being true and being false.
/// `handed` are calls to internal code that neither returns a value computed
/// from the caller nor checks it: the caller as their argument says nothing.
#[derive(Default)]
struct Who {
    aliases: BTreeSet<i64>,
    calls: BTreeMap<Ptr, Excludes>,
    handed: BTreeSet<Ptr>,
}

// `selfdestruct(x)`, and `suicide(x)` before solc 0.5: the builtins, not a
// function of the same name.
fn is_selfdestruct(call: &Value) -> bool {
    matches!(callee_name(call), "selfdestruct" | "suicide")
        && call
            .get("expression")
            .and_then(referenced)
            .is_none_or(|id| id < 0)
}

fn reverts(branch: &Value) -> bool {
    let mut found = false;
    walk(branch, &mut |x| {
        found |= s(x, "nodeType") == "RevertStatement"
            || (s(x, "nodeType") == "FunctionCall"
                && matches!(callee_name(x), "revert" | "require" | "assert"));
    });
    found
}

// The Yul builtins an inline assembly block calls. Before solc 0.6 the block
// is only text.
fn yul_calls(asm: &Value) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    walk(asm, &mut |x| {
        if s(x, "nodeType") == "YulFunctionCall"
            && let Some(n) = x.pointer("/functionName/name").and_then(Value::as_str)
        {
            names.insert(n.to_string());
        }
    });
    let text = s(asm, "operations");
    for (i, _) in text.match_indices('(') {
        let word: String = text[..i]
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        names.insert(word.chars().rev().collect());
    }
    names
}

// Inline assembly that reads the caller and can revert.
fn assembly_checks_caller(asm: &Value) -> bool {
    let names = yul_calls(asm);
    (names.contains("caller") || names.contains("origin")) && names.contains("revert")
}

/// The caller checks written in one body, each with the condition it tests
/// (none for assembly).
///
/// A caller check is a `require(...)` or `assert(...)` call, an `if` whose
/// branch reverts (a `revert` statement or a call to `revert`, `require` or
/// `assert`), or an inline assembly block that has both `caller()` or
/// `origin()` and `revert(`, where the condition uses the caller outside of
/// a `<`, `>`, `<=` or `>=` comparison, not only in an `==` or `!=` against
/// the zero address (unless the whole condition is the caller itself against
/// zero, see `caller_vs_zero`) and not only as an argument of a
/// state-changing call into another contract, and where passing takes more than the caller
/// not being named (see `only_excludes`). An `if` that returns early, followed
/// by a revert in the same block, counts too. The caller is `msg.sender`,
/// `tx.origin`, `_msgSender()` or `msgSender()`, or one of `aliases` (see
/// `caller_aliases`).
fn own_checks<'a>(body: &'a Value, who: &Who) -> Vec<(&'a Value, Option<&'a Value>)> {
    let mut out = Vec::new();
    walk(body, &mut |x| match s(x, "nodeType") {
        "FunctionCall" if matches!(callee_name(x), "require" | "assert") => {
            if let Some(cond) = args_of(x).first()
                && (uses_caller(cond, who) || caller_vs_zero(cond))
                && !only_excludes(cond, false, who)
            {
                out.push((x, Some(cond)));
            }
        }
        "IfStatement" => {
            let branch = |k: &str| x.get(k).is_some_and(reverts);
            // A modifier that runs the function only for some callers:
            // `if (msg.sender == admin()) { _; } else { _fallback(); }`.
            let only = |k: &str, other: &str| {
                x.get(k).is_some_and(has_placeholder) && !x.get(other).is_some_and(has_placeholder)
            };
            let pass_on_false = branch("trueBody") || only("falseBody", "trueBody");
            if let Some(cond) = x.get("condition")
                && (branch("trueBody")
                    || branch("falseBody")
                    || only("trueBody", "falseBody")
                    || only("falseBody", "trueBody"))
                && (uses_caller(cond, who) || caller_vs_zero(cond))
                && !only_excludes(cond, pass_on_false, who)
            {
                out.push((x, Some(cond)));
            }
        }
        "InlineAssembly" if assembly_checks_caller(x) => out.push((x, None)),
        // `if (isOwner(msg.sender)) return; revert Unauthorized();`
        "Block" | "UncheckedBlock" => {
            let stmts = items(x, "statements");
            for (i, st) in stmts.iter().enumerate() {
                if s(st, "nodeType") == "IfStatement"
                    && st.get("falseBody").is_none_or(Value::is_null)
                    && st.get("trueBody").is_some_and(returns)
                    && let Some(cond) = st.get("condition")
                    && stmts[i + 1..].iter().any(always_reverts)
                    && (uses_caller(cond, who) || caller_vs_zero(cond))
                    && !only_excludes(cond, false, who)
                {
                    out.push((st, Some(cond)));
                }
            }
        }
        _ => {}
    });
    out
}

// Whether a check lets every caller through except those named somewhere:
// `require(!blacklisted[msg.sender])`. It stops some callers and trusts
// nobody, so it is no caller check. `negated` is set when the check passes
// on the condition being false (`if (cond) revert`).
fn only_excludes(cond: &Value, negated: bool, who: &Who) -> bool {
    match (s(cond, "nodeType"), s(cond, "operator")) {
        ("UnaryOperation", "!") => only_excludes(
            cond.get("subExpression").unwrap_or(&Value::Null),
            !negated,
            who,
        ),
        ("BinaryOperation", op @ ("==" | "!=")) => {
            let l = cond.get("leftExpression").unwrap_or(&Value::Null);
            let r = cond.get("rightExpression").unwrap_or(&Value::Null);
            // `msg.sender == owner` names who passes; so does a lookup that
            // must be set (`wards[msg.sender] == 1`, `minters[msg.sender] != 0`).
            let names_who_passes =
                is_caller(l, who) || is_caller(r, who) || !(is_zero(l) || is_zero(r));
            let needs_equal = (op == "==") != negated;
            needs_equal != names_who_passes
        }
        ("BinaryOperation", _) => false,
        ("TupleExpression", _) => match items(cond, "components") {
            [one] => only_excludes(one, negated, who),
            _ => false,
        },
        // A call whose result is computed from the caller excludes as what
        // it returns does.
        ("FunctionCall", _) => match who.calls.get(&ptr(cond)) {
            Some(excludes) => excludes[usize::from(negated)],
            _ => negated,
        },
        _ => negated,
    }
}

fn has_placeholder(branch: &Value) -> bool {
    let mut found = false;
    walk(branch, &mut |x| {
        found |= s(x, "nodeType") == "PlaceholderStatement"
    });
    found
}

fn returns(branch: &Value) -> bool {
    let mut found = false;
    walk(branch, &mut |x| found |= s(x, "nodeType") == "Return");
    found && !reverts(branch)
}

// A statement that reverts whenever it runs.
fn always_reverts(st: &Value) -> bool {
    s(st, "nodeType") == "RevertStatement"
        || (s(st, "nodeType") == "ExpressionStatement"
            && st
                .get("expression")
                .is_some_and(|e| s(e, "nodeType") == "FunctionCall" && callee_name(e) == "revert"))
}

// What a function definition is. Before solc 0.5 the AST has no `kind`.
fn kind_of(n: &Value) -> &str {
    match n.get("kind").and_then(Value::as_str) {
        Some(k) => k,
        None if n.get("isConstructor") == Some(&Value::Bool(true)) => "constructor",
        None if s(n, "name").is_empty() => "fallback",
        None => "function",
    }
}

fn implemented(f: &Value) -> bool {
    f.get("implemented")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| f.get("body").is_some_and(Value::is_object))
}

fn params(f: &Value) -> &[Value] {
    f.get("parameters").map_or(&[], |p| items(p, "parameters"))
}

fn param_types(f: &Value) -> Vec<&str> {
    params(f).iter().map(type_string).collect()
}

// Where storage is written from: `a[i].b` -> a, and `$.b` keeps the member,
// since `$` may be a pointer to namespaced storage.
#[derive(Clone, Debug)]
struct Root {
    id: Option<i64>,
    name: String,
    member: Option<String>,
    /// `_getStorage().field`: a field of namespaced storage, by struct.
    slot: Option<String>,
}

// `_getStorage().field`, a field of the struct a function returned from storage.
fn slot_member(x: &Value) -> Option<(String, String)> {
    let base = x.get("expression")?;
    let ty = type_string(base);
    (s(x, "nodeType") == "MemberAccess"
        && s(base, "nodeType") == "FunctionCall"
        && ty.starts_with("struct ")
        && ty.contains(" storage"))
    .then(|| (struct_of(ty), s(x, "memberName").to_string()))
}

// The slot of `StorageSlot.getAddressSlot(SLOT).value` (or `SLOT.getAddressSlot()`
// with `using StorageSlot for bytes32`), for any `StorageSlot*` library.
fn storage_slot_of(x: &Value) -> Option<&Value> {
    let call = x.get("expression")?;
    let getter = call.get("expression")?;
    let name = s(getter, "memberName");
    let lib = struct_of(type_string(call));
    if s(x, "nodeType") != "MemberAccess"
        || s(x, "memberName") != "value"
        || s(call, "nodeType") != "FunctionCall"
        || !(lib.starts_with("StorageSlot") && lib.contains('.'))
        || !(name.starts_with("get") && name.ends_with("Slot"))
    {
        return None;
    }
    let base = getter.get("expression")?;
    if type_string(base).starts_with("type(library ") {
        args_of(call).first()
    } else {
        Some(base)
    }
}

fn roots_of(expr: &Value, out: &mut Vec<Root>) {
    match s(expr, "nodeType") {
        "Identifier" => out.push(Root {
            id: referenced(expr),
            name: s(expr, "name").to_string(),
            member: None,
            slot: None,
        }),
        "IndexAccess" | "IndexRangeAccess" => {
            roots_of(expr.get("baseExpression").unwrap_or(&Value::Null), out);
        }
        "MemberAccess" => {
            let base = expr.get("expression").unwrap_or(&Value::Null);
            if let Some((slot, member)) = slot_member(expr) {
                out.push(Root {
                    id: None,
                    name: String::new(),
                    member: Some(member),
                    slot: Some(slot),
                });
            } else if s(base, "nodeType") == "Identifier" {
                out.push(Root {
                    id: referenced(base),
                    name: s(base, "name").to_string(),
                    member: Some(s(expr, "memberName").to_string()),
                    slot: None,
                });
            } else {
                roots_of(base, out);
            }
        }
        "TupleExpression" => {
            for c in items(expr, "components") {
                roots_of(c, out);
            }
        }
        _ => {}
    }
}

// `struct MultiOwnable.MultiOwnableStorage storage pointer` -> the struct's name.
fn struct_of(ty: &str) -> String {
    let ty = ty.strip_prefix("struct ").unwrap_or(ty);
    ty.split(' ').next().unwrap_or(ty).to_string()
}

// The declarations made inside one function or modifier.
#[derive(Default)]
struct Locals {
    ids: BTreeSet<i64>,
    params: Vec<i64>,
    storage_params: BTreeSet<usize>,
    /// Local `storage` pointers, with what each points into.
    pointers: BTreeMap<i64, Vec<Root>>,
    /// Local `storage` pointers a function call returned: namespaced
    /// storage (ERC-7201), known by the struct's type.
    slots: BTreeMap<i64, String>,
}

impl Locals {
    fn of(def: &Value) -> Self {
        let mut out = Self::default();
        for (j, p) in params(def).iter().enumerate() {
            let id = node_id(p).unwrap_or(-1);
            out.params.push(id);
            if s(p, "storageLocation") == "storage" {
                out.storage_params.insert(j);
            }
        }
        walk(def, &mut |x| match s(x, "nodeType") {
            "VariableDeclaration" => out.ids.extend(node_id(x)),
            "VariableDeclarationStatement" => {
                let decls: Vec<&Value> = items(x, "declarations")
                    .iter()
                    .filter(|d| d.is_object())
                    .collect();
                if let ([d], Some(init)) = (decls.as_slice(), x.get("initialValue"))
                    && s(d, "storageLocation") == "storage"
                    && let Some(id) = node_id(d)
                {
                    let mut to = Vec::new();
                    roots_of(init, &mut to);
                    if !to.is_empty() {
                        out.pointers.insert(id, to);
                    } else if s(init, "nodeType") == "FunctionCall" {
                        out.slots.insert(id, struct_of(type_string(d)));
                    }
                }
            }
            _ => {}
        });
        out
    }
}

/// A state variable: declared by a contract, or a field of namespaced
/// storage (`$._roles`).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum VarKey {
    Var(usize, String),
    Slot(String, String),
    /// A slot written through `StorageSlot`: the constant's name (empty
    /// when it is no named constant), and where it is declared or, unnamed,
    /// written, with the contract there.
    Raw(String, String, usize, String),
}

impl VarKey {
    fn name(&self) -> &str {
        match self {
            Self::Var(_, n) | Self::Slot(_, n) => n,
            Self::Raw(n, ..) if n.is_empty() => "an unnamed slot",
            Self::Raw(n, ..) => n,
        }
    }
}

#[derive(Default)]
struct Effects {
    vars: BTreeSet<VarKey>,
    /// Written by the function itself, not by what it calls.
    direct: BTreeSet<VarKey>,
    /// Its `storage` parameters it writes through.
    params: BTreeSet<usize>,
    asm_store: bool,
    selfdestruct: bool,
}

#[derive(Clone, Copy)]
struct Def<'a> {
    node: &'a Value,
    unit: usize,
    /// The contract that defines it; none for a free function.
    con: Option<usize>,
}

#[derive(Clone)]
enum Callee<'a> {
    /// Its code, and the expression passed for each of its parameters.
    Def(Def<'a>, Vec<&'a Value>),
    /// Internal code whose source was not found.
    Unknown(String),
    /// A builtin, an event, an error, or a call into another contract.
    Other,
}

struct Con<'a> {
    unit: usize,
    node: &'a Value,
    name: &'a str,
    kind: &'a str,
    is_abstract: bool,
}

impl<'a> Con<'a> {
    fn members(&self, t: &'a str) -> impl Iterator<Item = &'a Value> + 'a {
        items(self.node, "nodes")
            .iter()
            .filter(move |n| s(n, "nodeType") == t)
    }
}

struct Lin {
    order: Vec<usize>,
    unresolved: Vec<String>,
}

type Ptr = usize;

fn ptr(v: &Value) -> Ptr {
    std::ptr::from_ref(v) as usize
}

// C3 merge, as the compiler does it.
fn merge(mut seqs: Vec<Vec<usize>>) -> Vec<usize> {
    let mut out = Vec::new();
    loop {
        seqs.retain(|q| !q.is_empty());
        if seqs.is_empty() {
            return out;
        }
        let head = seqs
            .iter()
            .map(|q| q[0])
            .find(|h| !seqs.iter().any(|q| q[1..].contains(h)));
        let Some(h) = head else {
            // The compiler would have refused it; keep a stable order.
            for x in seqs.into_iter().flatten() {
                if !out.contains(&x) {
                    out.push(x);
                }
            }
            return out;
        };
        out.push(h);
        for q in &mut seqs {
            if q[0] == h {
                q.remove(0);
            }
        }
    }
}

struct Index<'a> {
    units: &'a [Unit],
    by_path: BTreeMap<&'a str, usize>,
    newlines: Vec<Vec<usize>>,
    cons: Vec<Con<'a>>,
    local: Vec<BTreeMap<&'a str, usize>>,
    imports: Vec<Vec<&'a Value>>,
    usings: Vec<Vec<&'a Value>>,
    /// Functions and modifiers by id, per file.
    decls: Vec<BTreeMap<i64, &'a Value>>,
    /// Constants by id, per file.
    consts: Vec<BTreeMap<i64, &'a Value>>,
    owner: BTreeMap<Ptr, usize>,
    lins: RefCell<BTreeMap<usize, Rc<Lin>>>,
    locals: RefCell<BTreeMap<Ptr, Rc<Locals>>>,
}

impl<'a> Index<'a> {
    fn new(units: &'a [Unit]) -> Self {
        let mut ix = Index {
            units,
            by_path: BTreeMap::new(),
            newlines: Vec::new(),
            cons: Vec::new(),
            local: Vec::new(),
            imports: Vec::new(),
            usings: Vec::new(),
            decls: Vec::new(),
            consts: Vec::new(),
            owner: BTreeMap::new(),
            lins: RefCell::new(BTreeMap::new()),
            locals: RefCell::new(BTreeMap::new()),
        };
        for (u, unit) in units.iter().enumerate() {
            ix.by_path.entry(unit.path.as_str()).or_insert(u);
            ix.newlines.push(
                unit.source
                    .bytes()
                    .enumerate()
                    .filter(|(_, b)| *b == b'\n')
                    .map(|(i, _)| i)
                    .collect(),
            );
            let mut local = BTreeMap::new();
            let mut imports = Vec::new();
            let mut usings = Vec::new();
            for n in items(&unit.ast, "nodes") {
                match s(n, "nodeType") {
                    "ContractDefinition" => {
                        let c = ix.cons.len();
                        local.insert(s(n, "name"), c);
                        for m in items(n, "nodes") {
                            ix.owner.insert(ptr(m), c);
                        }
                        ix.cons.push(Con {
                            unit: u,
                            node: n,
                            name: s(n, "name"),
                            kind: s(n, "contractKind"),
                            is_abstract: n.get("abstract") == Some(&Value::Bool(true))
                                || n.get("fullyImplemented") == Some(&Value::Bool(false)),
                        });
                    }
                    "ImportDirective" => imports.push(n),
                    "UsingForDirective" => usings.push(n),
                    _ => {}
                }
            }
            let mut decls = BTreeMap::new();
            let mut consts = BTreeMap::new();
            walk(&unit.ast, &mut |x| {
                let Some(id) = node_id(x) else { return };
                match s(x, "nodeType") {
                    "FunctionDefinition" | "ModifierDefinition" => {
                        decls.insert(id, x);
                    }
                    "VariableDeclaration" if x.get("constant") == Some(&Value::Bool(true)) => {
                        consts.insert(id, x);
                    }
                    _ => {}
                }
            });
            ix.local.push(local);
            ix.imports.push(imports);
            ix.usings.push(usings);
            ix.decls.push(decls);
            ix.consts.push(consts);
        }
        ix
    }

    fn line(&self, unit: usize, node: &Value) -> usize {
        let start: usize = s(node, "src")
            .split(':')
            .next()
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
        self.newlines[unit].partition_point(|p| *p < start) + 1
    }

    fn at(&self, unit: usize, node: &Value) -> String {
        format!("{}:{}", self.units[unit].path, self.line(unit, node))
    }

    fn imported(&self, imp: &Value) -> Option<usize> {
        self.by_path.get(s(imp, "absolutePath")).copied()
    }

    /// The contract or library a name means in a file: defined there, or
    /// brought in by its imports. `Alias.Name` goes through `import "x" as Alias`.
    fn resolve(&self, unit: usize, name: &str) -> Option<usize> {
        if let Some((alias, rest)) = name.split_once('.') {
            return self.imports[unit]
                .iter()
                .filter(|i| s(i, "unitAlias") == alias)
                .find_map(|i| self.exposed(self.imported(i)?, rest, &mut BTreeSet::new()));
        }
        self.exposed(unit, name, &mut BTreeSet::new())
    }

    fn exposed(
        &self,
        unit: usize,
        name: &str,
        seen: &mut BTreeSet<(usize, String)>,
    ) -> Option<usize> {
        if !seen.insert((unit, name.to_string())) {
            return None;
        }
        if let Some(c) = self.local[unit].get(name) {
            return Some(*c);
        }
        for imp in &self.imports[unit] {
            let Some(u) = self.imported(imp) else {
                continue;
            };
            let aliases = items(imp, "symbolAliases");
            if !aliases.is_empty() {
                for a in aliases {
                    let foreign = a.get("foreign").unwrap_or(&Value::Null);
                    let local = a.get("local").and_then(Value::as_str);
                    // Old trees give the foreign symbol as a bare id.
                    let theirs = foreign.get("name").and_then(Value::as_str);
                    let mine = local.or(theirs);
                    let found = match (mine, theirs) {
                        (Some(m), Some(t)) if m == name => self.exposed(u, t, seen),
                        (Some(m), None) if m == name => self.exposed(u, name, seen),
                        (None, None) => self.exposed(u, name, seen),
                        _ => None,
                    };
                    if found.is_some() {
                        return found;
                    }
                }
            } else if s(imp, "unitAlias").is_empty()
                && let Some(c) = self.exposed(u, name, seen)
            {
                return Some(c);
            }
        }
        None
    }

    /// The linearization: the contract, then its bases, most derived first.
    fn lin(&self, c: usize) -> Rc<Lin> {
        if let Some(l) = self.lins.borrow().get(&c) {
            return Rc::clone(l);
        }
        // An inheritance cycle does not compile; this only stops the recursion.
        self.lins.borrow_mut().insert(
            c,
            Rc::new(Lin {
                order: vec![c],
                unresolved: vec![],
            }),
        );
        let con = &self.cons[c];
        let mut unresolved = Vec::new();
        let mut bases = Vec::new();
        for b in items(con.node, "baseContracts") {
            let name = b
                .pointer("/baseName/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match self.resolve(con.unit, name) {
                Some(bc) if bc != c => bases.push(bc),
                _ => unresolved.push(name.to_string()),
            }
        }
        // `contract C is A, B`: B is the more derived.
        let mut seqs: Vec<Vec<usize>> = Vec::new();
        for b in bases.iter().rev() {
            let l = self.lin(*b);
            unresolved.extend(l.unresolved.iter().cloned());
            seqs.push(l.order.clone());
        }
        seqs.push(bases.iter().rev().copied().collect());
        let mut order = vec![c];
        order.extend(merge(seqs));
        let mut seen = BTreeSet::new();
        unresolved.retain(|n| seen.insert(n.clone()));
        let l = Rc::new(Lin { order, unresolved });
        self.lins.borrow_mut().insert(c, Rc::clone(&l));
        l
    }

    fn locals(&self, def: &Value) -> Rc<Locals> {
        if let Some(l) = self.locals.borrow().get(&ptr(def)) {
            return Rc::clone(l);
        }
        let l = Rc::new(Locals::of(def));
        self.locals.borrow_mut().insert(ptr(def), Rc::clone(&l));
        l
    }

    fn def(&self, node: &'a Value, unit: usize) -> Def<'a> {
        Def {
            node,
            unit,
            con: self.owner.get(&ptr(node)).copied(),
        }
    }

    fn is_library(&self, d: &Def) -> bool {
        d.con.is_some_and(|c| self.cons[c].kind == "library")
    }
}

enum Want<'b> {
    Types(Vec<&'b str>),
    Arity(usize),
}

// What is known about one target contract, with its linearization: virtual
// calls dispatch differently for each target, so nothing is shared between them.
struct Ctx<'i, 'a> {
    ix: &'i Index<'a>,
    lin: Rc<Lin>,
    checked: RefCell<BTreeMap<(Ptr, Vec<usize>), bool>>,
    returned: RefCell<BTreeMap<Tainted, Option<Excludes>>>,
    unknown: RefCell<BTreeMap<Ptr, bool>>,
    effects: RefCell<BTreeMap<Ptr, Rc<Effects>>>,
    reads: RefCell<BTreeMap<Ptr, Rc<BTreeSet<VarKey>>>>,
    calls: RefCell<BTreeMap<Ptr, CallList<'a>>>,
}

type CallList<'a> = Rc<Vec<(&'a Value, Callee<'a>)>>;

impl<'i, 'a> Ctx<'i, 'a> {
    fn new(ix: &'i Index<'a>, target: usize) -> Self {
        Self {
            ix,
            lin: ix.lin(target),
            checked: RefCell::new(BTreeMap::new()),
            returned: RefCell::new(BTreeMap::new()),
            unknown: RefCell::new(BTreeMap::new()),
            effects: RefCell::new(BTreeMap::new()),
            reads: RefCell::new(BTreeMap::new()),
            calls: RefCell::new(BTreeMap::new()),
        }
    }

    fn pos(&self, c: usize) -> Option<usize> {
        self.lin.order.iter().position(|x| *x == c)
    }

    // Where a call or a modifier made from `d` is looked up: the whole
    // linearization, or only the library that `d` is part of.
    fn space(&self, d: &Def) -> Vec<usize> {
        match d.con {
            Some(c) if self.pos(c).is_some() => self.lin.order.clone(),
            Some(c) => vec![c],
            None => vec![],
        }
    }

    fn find_fn(&self, space: &[usize], name: &str, want: &Want) -> Option<Def<'a>> {
        space.iter().find_map(|c| {
            let con = &self.ix.cons[*c];
            con.members("FunctionDefinition")
                .find(|f| {
                    s(f, "name") == name
                        && implemented(f)
                        && match want {
                            Want::Types(t) => param_types(f) == *t,
                            Want::Arity(n) => params(f).len() == *n,
                        }
                })
                .map(|f| Def {
                    node: f,
                    unit: con.unit,
                    con: Some(*c),
                })
        })
    }

    // The libraries attached with `using L for T` where `d` is written.
    fn usings(&self, d: &Def) -> Vec<usize> {
        let mut dirs: Vec<(usize, &'a Value)> = self.ix.usings[d.unit]
            .iter()
            .map(|u| (d.unit, *u))
            .collect();
        let mut cons: Vec<usize> = d.con.into_iter().collect();
        if d.con.is_some_and(|c| self.pos(c).is_some()) {
            // Before solc 0.7 a directive was inherited.
            cons.extend(self.lin.order.iter().copied());
        }
        for c in cons {
            let con = &self.ix.cons[c];
            dirs.extend(con.members("UsingForDirective").map(|u| (con.unit, u)));
        }
        let mut out = Vec::new();
        for (unit, dir) in dirs {
            let mut names: Vec<&str> = Vec::new();
            names.extend(dir.pointer("/libraryName/name").and_then(Value::as_str));
            for f in items(dir, "functionList") {
                if let Some((lib, _)) = f
                    .pointer("/function/name")
                    .and_then(Value::as_str)
                    .and_then(|n| n.rsplit_once('.'))
                {
                    names.push(lib);
                }
            }
            for n in names {
                if let Some(c) = self.ix.resolve(unit, n)
                    && !out.contains(&c)
                {
                    out.push(c);
                }
            }
        }
        out
    }

    fn static_decl(&self, d: &Def, e: &Value) -> Option<&'a Value> {
        referenced(e)
            .and_then(|id| self.ix.decls[d.unit].get(&id))
            .copied()
            .filter(|x| s(x, "nodeType") == "FunctionDefinition")
    }

    fn want(&self, d: &Def, e: &Value, arity: usize) -> Want<'a> {
        match self.static_decl(d, e) {
            Some(st) => Want::Types(param_types(st)),
            None => Want::Arity(arity),
        }
    }

    /// What a call made in `d` runs.
    fn callee(&self, d: &Def<'a>, call: &'a Value) -> Callee<'a> {
        if s(call, "nodeType") != "FunctionCall"
            || is_conversion(call)
            || s(call, "kind") == "structConstructorCall"
        {
            return Callee::Other;
        }
        let mut e = call.get("expression").unwrap_or(&Value::Null);
        while s(e, "nodeType") == "FunctionCallOptions" {
            e = e.get("expression").unwrap_or(&Value::Null);
        }
        let ty = type_id(e);
        let args: Vec<&'a Value> = args_of(call).iter().collect();
        match s(e, "nodeType") {
            "Identifier" => {
                let Some(refd) = referenced(e).filter(|r| *r >= 0) else {
                    return Callee::Other;
                };
                if (!ty.is_empty() && !ty.starts_with("t_function_internal"))
                    || self.ix.locals(d.node).ids.contains(&refd)
                {
                    return Callee::Other;
                }
                let name = s(e, "name");
                if let Some(st) = self.static_decl(d, e) {
                    let st = self.ix.def(st, d.unit);
                    let fixed = s(st.node, "visibility") == "private"
                        || self.ix.is_library(&st)
                        || st.con.is_none_or(|c| self.pos(c).is_none());
                    let found = if fixed {
                        Some(st)
                    } else {
                        self.find_fn(&self.space(d), name, &Want::Types(param_types(st.node)))
                    };
                    return match found.or(implemented(st.node).then_some(st)) {
                        Some(f) => Callee::Def(f, args),
                        None => Callee::Unknown(name.to_string()),
                    };
                }
                match self.find_fn(&self.space(d), name, &Want::Arity(args.len())) {
                    Some(f) => Callee::Def(f, args),
                    None => Callee::Unknown(name.to_string()),
                }
            }
            "MemberAccess" => {
                let base = e.get("expression").unwrap_or(&Value::Null);
                let member = s(e, "memberName");
                let bty = type_string(base);
                if s(base, "name") == "super" || bty.starts_with("type(contract super ") {
                    let Some(p) = d.con.and_then(|c| self.pos(c)) else {
                        return Callee::Other;
                    };
                    let want = self.want(d, e, args.len());
                    return match self.find_fn(&self.lin.order[p + 1..], member, &want) {
                        Some(f) => Callee::Def(f, args),
                        None => Callee::Unknown(member.to_string()),
                    };
                }
                if bty.starts_with("type(library ") || bty.starts_with("type(contract ") {
                    let name = match s(base, "nodeType") {
                        "Identifier" => s(base, "name").to_string(),
                        _ => arg_text(base, 0),
                    };
                    let Some(c) = self.ix.resolve(d.unit, &name) else {
                        return if bty.starts_with("type(library ") {
                            Callee::Unknown(member.to_string())
                        } else {
                            Callee::Other
                        };
                    };
                    let want = self.want(d, e, args.len());
                    return match self.find_fn(&[c], member, &want) {
                        Some(f) => Callee::Def(f, args),
                        None if self.ix.cons[c].kind == "library" => {
                            Callee::Unknown(member.to_string())
                        }
                        None => Callee::Other,
                    };
                }
                if ty.contains("$bound_to$") || ty.contains("$attached_to$") {
                    let mut with: Vec<&'a Value> = vec![base];
                    with.extend(args);
                    let libs = self.usings(d);
                    return match self.find_fn(&libs, member, &Want::Arity(with.len())) {
                        Some(f) => Callee::Def(f, with),
                        None => Callee::Unknown(member.to_string()),
                    };
                }
                Callee::Other
            }
            _ => Callee::Other,
        }
    }

    /// What a modifier invocation in `d` runs.
    fn modifier(&self, d: &Def<'a>, inv: &'a Value) -> Callee<'a> {
        if s(inv, "kind") == "baseConstructorSpecifier" {
            return Callee::Other;
        }
        let name = inv
            .pointer("/modifierName/name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let args: Vec<&'a Value> = args_of(inv).iter().collect();
        for c in self.space(d) {
            let con = &self.ix.cons[c];
            if let Some(m) = con
                .members("ModifierDefinition")
                .find(|m| s(m, "name") == name && m.get("body").is_some_and(Value::is_object))
            {
                return Callee::Def(
                    Def {
                        node: m,
                        unit: con.unit,
                        con: Some(c),
                    },
                    args,
                );
            }
        }
        // A base constructor called with its arguments.
        if self.ix.resolve(d.unit, name).is_some() {
            return Callee::Other;
        }
        Callee::Unknown(name.to_string())
    }

    fn modifiers(&self, d: &Def<'a>) -> Vec<(&'a Value, Callee<'a>)> {
        items(d.node, "modifiers")
            .iter()
            .map(|m| (m, self.modifier(d, m)))
            .collect()
    }

    fn calls(&self, d: &Def<'a>) -> CallList<'a> {
        if let Some(c) = self.calls.borrow().get(&ptr(d.node)) {
            return Rc::clone(c);
        }
        let mut found = Vec::new();
        walk(d.node.get("body").unwrap_or(&Value::Null), &mut |x| {
            if s(x, "nodeType") == "FunctionCall" {
                found.push(x);
            }
        });
        let list: CallList<'a> =
            Rc::new(found.into_iter().map(|x| (x, self.callee(d, x))).collect());
        self.calls
            .borrow_mut()
            .insert(ptr(d.node), Rc::clone(&list));
        list
    }

    // A public function called from inside is an entry point with its own
    // report, and it may be called with the caller already as the argument
    // it checks (`transferFrom(msg.sender, ...)`).
    fn followed(&self, d: &Def) -> bool {
        matches!(s(d.node, "visibility"), "internal" | "private")
            || s(d.node, "nodeType") == "ModifierDefinition"
            || self.ix.is_library(d)
    }

    /// What stands for the caller in `d` when the parameters at `taint`
    /// hold it. Aliases and calls feed each other (`bool ok = _isAuth(a)`,
    /// `_isAuth(u)` with `u` an alias), so they are worked out again until
    /// none changes.
    fn who(&self, d: &Def<'a>, taint: &[usize]) -> Who {
        let loc = self.ix.locals(d.node);
        let body = d.node.get("body").unwrap_or(&Value::Null);
        let base: BTreeSet<i64> = taint
            .iter()
            .filter_map(|j| loc.params.get(*j).copied())
            .collect();
        let mut who = Who::default();
        let list = self.calls(d);
        // Aliases start over each round: one taken from a call only later
        // found `handed` (`bool ok = _enough(msg.sender, x)`) must go. The
        // bound only guards against a cycle; real code settles in a few rounds.
        for _ in 0..list.len() + 2 {
            let before = std::mem::replace(&mut who.aliases, base.clone());
            caller_aliases(body, &mut who);
            let mut calls = BTreeMap::new();
            let mut handed = BTreeSet::new();
            for (x, c) in list.iter() {
                if let Callee::Def(cd, args) = c
                    && self.followed(cd)
                    && s(cd.node, "nodeType") == "FunctionDefinition"
                {
                    let t = Self::taint(args, &who);
                    if let Some(excludes) = self.returns_caller(cd, &t) {
                        calls.insert(ptr(x), excludes);
                    } else if !t.is_empty() && !self.has_check(cd, &t) {
                        handed.insert(ptr(x));
                    }
                }
            }
            if calls == who.calls && handed == who.handed && before == who.aliases {
                return who;
            }
            who.calls = calls;
            who.handed = handed;
        }
        who
    }

    /// Whether what `d` returns is computed from the caller under the rule
    /// of `uses_caller`, when the parameters at `taint` hold it, and if so
    /// whether it only excludes callers (`only_excludes`) when a check passes
    /// on it being true and on it being false. With several returns, it
    /// excludes only when each one that uses the caller does.
    fn returns_caller(&self, d: &Def<'a>, taint: &[usize]) -> Option<Excludes> {
        let key = (ptr(d.node), taint.to_vec());
        if let Some(known) = self.returned.borrow().get(&key) {
            return *known;
        }
        // A recursive call says nothing about the caller of its own.
        self.returned.borrow_mut().insert(key.clone(), None);
        let who = self.who(d, taint);
        let named: BTreeSet<i64> = d
            .node
            .get("returnParameters")
            .map_or(&[][..], |p| items(p, "parameters"))
            .iter()
            .filter_map(node_id)
            .collect();
        let mut values = Vec::new();
        walk(d.node.get("body").unwrap_or(&Value::Null), &mut |x| {
            match s(x, "nodeType") {
                "Return" => values.extend(x.get("expression").filter(|e| e.is_object())),
                // `returns (bool ok) { ok = ...; }`
                "Assignment"
                    if s(x, "operator") == "="
                        && x.get("leftHandSide")
                            .and_then(referenced)
                            .is_some_and(|id| named.contains(&id)) =>
                {
                    values.extend(x.get("rightHandSide"));
                }
                _ => {}
            }
        });
        let mut found: Option<Excludes> = None;
        for v in values.into_iter().filter(|v| uses_caller(v, &who)) {
            let here = [only_excludes(v, false, &who), only_excludes(v, true, &who)];
            let all = found.get_or_insert(here);
            all[0] &= here[0];
            all[1] &= here[1];
        }
        self.returned.borrow_mut().insert(key, found);
        found
    }

    fn taint(args: &[&Value], who: &Who) -> Vec<usize> {
        (0..args.len())
            .filter(|j| is_caller(args[*j], who))
            .collect()
    }

    /// Whether `d` checks the caller, itself or through what it runs, when
    /// the parameters at `taint` hold the caller.
    fn has_check(&self, d: &Def<'a>, taint: &[usize]) -> bool {
        let key = (ptr(d.node), taint.to_vec());
        if let Some(known) = self.checked.borrow().get(&key) {
            return *known;
        }
        // A recursive call is not a check of its own.
        self.checked.borrow_mut().insert(key.clone(), false);
        let who = self.who(d, taint);
        let body = d.node.get("body").unwrap_or(&Value::Null);
        let found = !own_checks(body, &who).is_empty()
            || self
                .modifiers(d)
                .iter()
                .any(|(m, c)| self.is_gate_call(m, c, &who))
            || self.calls(d).iter().any(|(_, c)| self.call_checks(c, &who));
        self.checked.borrow_mut().insert(key, found);
        found
    }

    // A call that checks the caller. A `_checkRole` or `_checkOwner` whose
    // source was not found is one: the standard libraries check it there.
    fn call_checks(&self, c: &Callee<'a>, who: &Who) -> bool {
        match c {
            Callee::Def(cd, args) => {
                self.followed(cd) && self.has_check(cd, &Self::taint(args, who))
            }
            Callee::Unknown(n) => matches!(n.as_str(), "_checkRole" | "_checkOwner"),
            Callee::Other => false,
        }
    }

    /// A modifier restricts who may call when it checks the caller. Only
    /// when code it runs could not be found does its name decide.
    fn is_gate_call(&self, inv: &Value, c: &Callee<'a>, who: &Who) -> bool {
        match c {
            Callee::Def(m, args) => {
                self.has_check(m, &Self::taint(args, who))
                    || (self.reaches_unknown(m) && is_gate(s(m.node, "name")))
            }
            Callee::Unknown(_) => is_gate(&modifier_text(inv)),
            Callee::Other => false,
        }
    }

    fn reaches_unknown(&self, d: &Def<'a>) -> bool {
        if let Some(known) = self.unknown.borrow().get(&ptr(d.node)) {
            return *known;
        }
        self.unknown.borrow_mut().insert(ptr(d.node), false);
        let found = self
            .modifiers(d)
            .iter()
            .chain(self.calls(d).iter())
            .any(|(_, c)| match c {
                Callee::Unknown(_) => true,
                Callee::Def(cd, _) => self.followed(cd) && self.reaches_unknown(cd),
                Callee::Other => false,
            });
        self.unknown.borrow_mut().insert(ptr(d.node), found);
        found
    }

    /// The lines of the caller checks a function runs in its own body: its
    /// own, and its calls to code that checks.
    fn check_lines(&self, d: &Def<'a>) -> Vec<usize> {
        let who = self.who(d, &[]);
        let body = d.node.get("body").unwrap_or(&Value::Null);
        let mut out: Vec<usize> = own_checks(body, &who)
            .iter()
            .map(|(x, _)| self.ix.line(d.unit, x))
            .chain(
                self.calls(d)
                    .iter()
                    .filter(|(_, c)| self.call_checks(c, &who))
                    .map(|(x, _)| self.ix.line(d.unit, x)),
            )
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    // The state variable a name in `d` means: declared by the nearest
    // contract from `d`'s own up the linearization.
    fn state_var(&self, d: &Def, name: &str, writable: bool) -> Option<VarKey> {
        let p = self.pos(d.con?)?;
        self.lin.order[p..].iter().find_map(|c| {
            self.ix.cons[*c]
                .members("VariableDeclaration")
                .find(|v| {
                    s(v, "name") == name
                        && (writable
                            || (v.get("constant") != Some(&Value::Bool(true))
                                && s(v, "mutability") != "immutable"))
                })
                .map(|_| VarKey::Var(*c, name.to_string()))
        })
    }

    // The constant a slot expression in `d` names: `IMPLEMENTATION_SLOT`
    // or `ERC1967Utils.IMPLEMENTATION_SLOT`. Anything else, a parameter or
    // a `keccak256(...)`, names none.
    fn slot_const(&self, d: &Def, e: &Value) -> Option<(usize, &'a Value)> {
        if let Some(v) = referenced(e).and_then(|id| self.ix.consts[d.unit].get(&id)) {
            return Some((d.unit, *v));
        }
        let (space, name) = match s(e, "nodeType") {
            "Identifier" => (self.space(d), s(e, "name")),
            "MemberAccess" => {
                let base = e.get("expression").unwrap_or(&Value::Null);
                if s(base, "nodeType") != "Identifier" {
                    return None;
                }
                (
                    self.ix
                        .resolve(d.unit, s(base, "name"))
                        .into_iter()
                        .collect(),
                    s(e, "memberName"),
                )
            }
            _ => return None,
        };
        space.iter().find_map(|c| {
            let con = &self.ix.cons[*c];
            con.members("VariableDeclaration")
                .find(|v| s(v, "name") == name && v.get("constant") == Some(&Value::Bool(true)))
                .map(|v| (con.unit, v))
        })
    }

    // The storage a `StorageSlot` write or read at `site` in `d` stands for.
    fn raw_slot(&self, d: &Def, slot: &Value, site: &Value) -> VarKey {
        let name =
            |c: Option<&usize>| c.map_or(String::new(), |c| self.ix.cons[*c].name.to_string());
        match self.slot_const(d, slot) {
            Some((unit, v)) => VarKey::Raw(
                s(v, "name").to_string(),
                self.ix.units[unit].path.clone(),
                self.ix.line(unit, v),
                name(self.ix.owner.get(&ptr(v))),
            ),
            None => VarKey::Raw(
                String::new(),
                self.ix.units[d.unit].path.clone(),
                self.ix.line(d.unit, site),
                name(d.con.as_ref()),
            ),
        }
    }

    // What storage a root in `d` stands for: a state variable, or one of
    // `d`'s own `storage` parameters.
    fn place(
        &self,
        d: &Def,
        loc: &Locals,
        r: &Root,
        hops: usize,
        out: &mut Vec<Result<VarKey, usize>>,
    ) {
        if let (Some(slot), Some(m)) = (&r.slot, &r.member) {
            out.push(Ok(VarKey::Slot(slot.clone(), m.clone())));
            return;
        }
        match r.id {
            Some(id) if loc.pointers.contains_key(&id) => {
                if hops > 0 {
                    for to in &loc.pointers[&id] {
                        self.place(d, loc, to, hops - 1, out);
                    }
                }
            }
            Some(id) if loc.slots.contains_key(&id) => {
                if let Some(m) = &r.member {
                    out.push(Ok(VarKey::Slot(loc.slots[&id].clone(), m.clone())));
                }
            }
            Some(id) if loc.ids.contains(&id) => {
                if let Some(j) = loc.params.iter().position(|p| *p == id)
                    && loc.storage_params.contains(&j)
                {
                    out.push(Err(j));
                }
            }
            _ => out.extend(self.state_var(d, &r.name, true).map(Ok)),
        }
    }

    fn effects(&self, d: &Def<'a>) -> Rc<Effects> {
        if let Some(e) = self.effects.borrow().get(&ptr(d.node)) {
            return Rc::clone(e);
        }
        self.effects
            .borrow_mut()
            .insert(ptr(d.node), Rc::new(Effects::default()));
        let loc = self.ix.locals(d.node);
        let mut out = Effects::default();
        let mut roots = Vec::new();
        let mut raw = Vec::new();
        let mut target = |e: &Value, roots: &mut Vec<Root>| match storage_slot_of(e) {
            Some(slot) => raw.push(self.raw_slot(d, slot, e)),
            None => roots_of(e, roots),
        };
        walk(
            d.node.get("body").unwrap_or(&Value::Null),
            &mut |x| match s(x, "nodeType") {
                "Assignment" => target(x.get("leftHandSide").unwrap_or(&Value::Null), &mut roots),
                "UnaryOperation" if matches!(s(x, "operator"), "delete" | "++" | "--") => {
                    target(x.get("subExpression").unwrap_or(&Value::Null), &mut roots);
                }
                "FunctionCall" => {
                    if let Some(e) = x.get("expression")
                        && s(e, "nodeType") == "MemberAccess"
                        && matches!(s(e, "memberName"), "push" | "pop")
                    {
                        roots_of(e.get("expression").unwrap_or(&Value::Null), &mut roots);
                    }
                    out.selfdestruct |= is_selfdestruct(x);
                }
                "InlineAssembly" => {
                    let names = yul_calls(x);
                    out.asm_store |= names.contains("sstore") || names.contains("tstore");
                    out.selfdestruct |= names.contains("selfdestruct");
                }
                _ => {}
            },
        );
        let mut places: Vec<Result<VarKey, usize>> = raw.into_iter().map(Ok).collect();
        for r in &roots {
            self.place(d, &loc, r, 8, &mut places);
        }
        let mods = self.modifiers(d);
        let calls = self.calls(d);
        for (_, c) in mods.iter().chain(calls.iter()) {
            let Callee::Def(cd, args) = c else { continue };
            let e = self.effects(cd);
            out.vars.extend(e.vars.iter().cloned());
            out.asm_store |= e.asm_store;
            out.selfdestruct |= e.selfdestruct;
            // A callee that writes through a `storage` parameter writes
            // whatever was passed for it: `set.add(x)` writes `set`.
            for j in &e.params {
                let mut rs = Vec::new();
                roots_of(args.get(*j).copied().unwrap_or(&Value::Null), &mut rs);
                for r in &rs {
                    self.place(d, &loc, r, 8, &mut places);
                }
            }
        }
        for p in places {
            match p {
                Ok(k) => {
                    out.direct.insert(k.clone());
                    out.vars.insert(k);
                }
                Err(j) => {
                    out.params.insert(j);
                }
            }
        }
        let e = Rc::new(out);
        self.effects.borrow_mut().insert(ptr(d.node), Rc::clone(&e));
        e
    }

    // The state an expression of `d` reads, and everything read by code it calls.
    fn reads_in(&self, d: &Def<'a>, expr: &'a Value, out: &mut BTreeSet<VarKey>) {
        let loc = self.ix.locals(d.node);
        walk(expr, &mut |x| match s(x, "nodeType") {
            "Identifier" => {
                if !referenced(x).is_some_and(|id| loc.ids.contains(&id))
                    && let Some(k) = self.state_var(d, s(x, "name"), false)
                {
                    out.insert(k);
                }
            }
            "MemberAccess" => {
                if let Some(slot) = storage_slot_of(x) {
                    out.insert(self.raw_slot(d, slot, x));
                } else if let Some((slot, m)) = slot_member(x) {
                    out.insert(VarKey::Slot(slot, m));
                } else if let Some(base) = x.get("expression")
                    && let Some(ty) = referenced(base).and_then(|id| loc.slots.get(&id))
                {
                    out.insert(VarKey::Slot(ty.clone(), s(x, "memberName").to_string()));
                }
            }
            "FunctionCall" => {
                if let Callee::Def(cd, _) = self.callee(d, x) {
                    out.extend(self.reads_all(&cd).iter().cloned());
                }
            }
            _ => {}
        });
    }

    fn reads_all(&self, d: &Def<'a>) -> Rc<BTreeSet<VarKey>> {
        if let Some(r) = self.reads.borrow().get(&ptr(d.node)) {
            return Rc::clone(r);
        }
        self.reads
            .borrow_mut()
            .insert(ptr(d.node), Rc::new(BTreeSet::new()));
        let mut out = BTreeSet::new();
        self.reads_in(d, d.node.get("body").unwrap_or(&Value::Null), &mut out);
        let r = Rc::new(out);
        self.reads.borrow_mut().insert(ptr(d.node), Rc::clone(&r));
        r
    }

    // The state the caller checks of `d` read, through what it runs.
    fn check_reads(
        &self,
        d: &Def<'a>,
        taint: &[usize],
        seen: &mut BTreeSet<Ptr>,
        out: &mut BTreeSet<VarKey>,
    ) {
        if !seen.insert(ptr(d.node)) {
            return;
        }
        let who = self.who(d, taint);
        let body = d.node.get("body").unwrap_or(&Value::Null);
        for (_, cond) in own_checks(body, &who) {
            if let Some(cond) = cond {
                self.reads_in(d, cond, out);
            }
        }
        for (inv, c) in self.modifiers(d).iter().chain(self.calls(d).iter()) {
            if let Callee::Def(cd, args) = c {
                let t = Self::taint(args, &who);
                let checks = if s(inv, "nodeType") == "ModifierInvocation" {
                    self.is_gate_call(inv, c, &who)
                } else {
                    self.followed(cd) && self.has_check(cd, &t)
                };
                if checks {
                    self.check_reads(cd, &t, seen, out);
                }
            }
        }
    }
}

/// The contracts of the project, read from the syntax trees of its files
/// and of every file they import. `is_project` tells the project's own
/// non-test files: their contracts are reported, the rest is what they use.
pub fn read(units: &[Unit], is_project: &dyn Fn(&str) -> bool) -> Vec<Contract> {
    let ix = Index::new(units);
    let project = |c: usize| is_project(&units[ix.cons[c].unit].path);
    let concrete: Vec<usize> = (0..ix.cons.len())
        .filter(|c| project(*c) && ix.cons[*c].kind == "contract" && !ix.cons[*c].is_abstract)
        .collect();
    let inherited: BTreeSet<usize> = concrete
        .iter()
        .flat_map(|c| ix.lin(*c).order[1..].to_vec())
        .collect();
    // An abstract contract that nothing of the project builds on is still
    // what the project ships, for someone else to inherit.
    let mut targets: Vec<usize> = (0..ix.cons.len())
        .filter(|c| {
            project(*c)
                && ix.cons[*c].kind == "contract"
                && (!ix.cons[*c].is_abstract || !inherited.contains(c))
        })
        .collect();
    targets.sort_by_key(|c| (ix.cons[*c].unit, ix.cons[*c].name));
    let mut out: Vec<Contract> = targets.iter().map(|t| analyse(&ix, *t, &project)).collect();
    // A concrete contract that another one builds on can still be deployed
    // alone, so it stays; the report says what else carries its code.
    for (i, t) in targets.iter().enumerate() {
        out[i].inherited_by = targets
            .iter()
            .filter(|o| ix.lin(**o).order[1..].contains(t))
            .map(|o| ix.cons[*o].name.to_string())
            .collect();
        // Two contracts of one name would otherwise share candidate ids.
        if targets
            .iter()
            .filter(|o| ix.cons[**o].name == ix.cons[*t].name)
            .count()
            > 1
        {
            let file = &units[ix.cons[*t].unit].path;
            let file = file.strip_suffix(".sol").unwrap_or(file);
            out[i].key = id_part(&format!("{} {file}", ix.cons[*t].name));
        }
    }
    out
}

fn analyse(ix: &Index, t: usize, project: &dyn Fn(usize) -> bool) -> Contract {
    let cx = Ctx::new(ix, t);
    let con = &ix.cons[t];
    let order = cx.lin.order.clone();
    // The most derived implementation of each signature is the one that runs.
    let mut sigs = BTreeSet::new();
    let mut entries: Vec<Def> = Vec::new();
    for c in &order {
        let k = &ix.cons[*c];
        if k.kind == "library" {
            continue;
        }
        for f in k.members("FunctionDefinition") {
            let kind = kind_of(f);
            if !matches!(kind, "function" | "fallback" | "receive")
                || !matches!(s(f, "visibility"), "external" | "public")
                || !implemented(f)
            {
                continue;
            }
            let name = if kind == "function" {
                s(f, "name")
            } else {
                kind
            };
            let sig: Vec<String> = std::iter::once(name)
                .chain(param_types(f))
                .map(str::to_string)
                .collect();
            if sigs.insert(sig) && matches!(s(f, "stateMutability"), "nonpayable" | "payable") {
                entries.push(Def {
                    node: f,
                    unit: k.unit,
                    con: Some(*c),
                });
            }
        }
    }
    let mut functions = Vec::new();
    // Each gate the contract uses, with what its check reads.
    let mut guard_reads: Vec<(String, BTreeSet<VarKey>)> = Vec::new();
    for d in &entries {
        let mut gates = Vec::new();
        let mut others = Vec::new();
        for (inv, c) in cx.modifiers(d) {
            let text = modifier_text(inv);
            if !cx.is_gate_call(inv, &c, &Who::default()) {
                if !matches!(c, Callee::Other) {
                    others.push(text);
                }
                continue;
            }
            gates.push(text);
            if let Callee::Def(m, args) = &c {
                let name = s(m.node, "name").to_string();
                if !guard_reads.iter().any(|(g, _)| *g == name) {
                    let mut reads = BTreeSet::new();
                    let t = Ctx::taint(args, &Who::default());
                    cx.check_reads(m, &t, &mut BTreeSet::new(), &mut reads);
                    guard_reads.push((name, reads));
                }
            }
        }
        let kind = kind_of(d.node);
        let c = d.con.unwrap_or(t);
        functions.push(Function {
            name: if kind == "function" {
                s(d.node, "name")
            } else {
                kind
            }
            .to_string(),
            file: ix.units[d.unit].path.clone(),
            line: ix.line(d.unit, d.node),
            contract: ix.cons[c].name.to_string(),
            library: !project(c),
            gates,
            others,
            checks: cx.check_lines(d),
            asm_store: cx.effects(d).asm_store,
            selfdestruct: cx.effects(d).selfdestruct,
        });
    }
    let writers_of = |keys: &BTreeSet<VarKey>| -> Vec<String> {
        uniq(
            entries
                .iter()
                .zip(&functions)
                .filter(|(d, _)| cx.effects(d).vars.iter().any(|k| keys.contains(k)))
                .map(|(_, f)| f.name.as_str()),
        )
        .into_iter()
        .map(str::to_string)
        .collect()
    };
    let mut constructors = Vec::new();
    let mut inner = Vec::new();
    for c in &order {
        let k = &ix.cons[*c];
        for f in k.members("FunctionDefinition") {
            let d = Def {
                node: f,
                unit: k.unit,
                con: Some(*c),
            };
            match kind_of(f) {
                "constructor" => constructors.push(d),
                "function" if !entries.iter().any(|e| std::ptr::eq(e.node, f)) => inner.push(d),
                _ => {}
            }
        }
    }
    // Namespaced storage (ERC-7201): the structs that code of the lineage
    // reaches through a pointer some function returns.
    // Each is shown with the most basic contract of its file that uses it.
    let mut slots: BTreeMap<String, usize> = BTreeMap::new();
    for c in &order {
        for n in items(ix.cons[*c].node, "nodes") {
            for st in ix.locals(n).slots.values() {
                slots.insert(st.clone(), *c);
            }
            walk(n, &mut |x| {
                if let Some((st, _)) = slot_member(x) {
                    slots.insert(st, *c);
                }
            });
        }
    }
    let mut state = Vec::new();
    for c in order.iter().filter(|c| project(**c)) {
        let k = &ix.cons[*c];
        let mut vars: Vec<(String, VarKey, &Value)> = k
            .members("VariableDeclaration")
            .map(|v| {
                (
                    s(v, "name").to_string(),
                    VarKey::Var(*c, s(v, "name").to_string()),
                    v,
                )
            })
            .collect();
        let structs = k
            .members("StructDefinition")
            .map(|st| (format!("{}.{}", k.name, s(st, "name")), st))
            .chain(
                items(&ix.units[k.unit].ast, "nodes")
                    .iter()
                    .filter(|n| s(n, "nodeType") == "StructDefinition")
                    .map(|st| (s(st, "name").to_string(), st)),
            );
        for (name, st) in structs {
            if slots.get(&name) == Some(c) {
                for m in items(st, "members") {
                    vars.push((
                        format!("{}.{}", s(st, "name"), s(m, "name")),
                        VarKey::Slot(name.clone(), s(m, "name").to_string()),
                        m,
                    ));
                }
            }
        }
        for (name, key, v) in vars {
            let keys = BTreeSet::from([key.clone()]);
            let writers = writers_of(&keys);
            let hooks = if writers.is_empty() {
                uniq(
                    inner
                        .iter()
                        .filter(|d| {
                            project(d.con.unwrap_or(t)) && cx.effects(d).direct.contains(&key)
                        })
                        .map(|d| s(d.node, "name")),
                )
                .into_iter()
                .map(str::to_string)
                .collect()
            } else {
                vec![]
            };
            state.push(StateVar {
                name,
                file: ix.units[k.unit].path.clone(),
                line: ix.line(k.unit, v),
                contract: k.name.to_string(),
                fixed: if v.get("constant") == Some(&Value::Bool(true)) {
                    "constant"
                } else if s(v, "mutability") == "immutable" {
                    "immutable"
                } else {
                    ""
                },
                writers,
                hooks,
                at_deployment: v.get("value").is_some_and(Value::is_object)
                    || constructors
                        .iter()
                        .any(|d| cx.effects(d).vars.contains(&key)),
            });
        }
    }
    // Slots written through `StorageSlot` (the ERC-1967 implementation and
    // admin), wherever the code that writes them comes from.
    let raws: BTreeSet<VarKey> = entries
        .iter()
        .chain(&constructors)
        .chain(&inner)
        .flat_map(|d| cx.effects(d).vars.iter().cloned().collect::<Vec<_>>())
        .filter(|k| matches!(k, VarKey::Raw(..)))
        .collect();
    for key in raws {
        let VarKey::Raw(named, file, line, contract) = &key else {
            continue;
        };
        let keys = BTreeSet::from([key.clone()]);
        let writers = writers_of(&keys);
        let hooks = if writers.is_empty() {
            uniq(
                inner
                    .iter()
                    .filter(|d| cx.effects(d).vars.contains(&key))
                    .map(|d| s(d.node, "name")),
            )
            .into_iter()
            .map(str::to_string)
            .collect()
        } else {
            vec![]
        };
        state.push(StateVar {
            name: if named.is_empty() {
                key.name().to_string()
            } else {
                format!("slot {named}")
            },
            file: file.clone(),
            line: *line,
            contract: if contract.is_empty() {
                con.name.to_string()
            } else {
                contract.clone()
            },
            fixed: "",
            writers,
            hooks,
            at_deployment: constructors
                .iter()
                .any(|d| cx.effects(d).vars.contains(&key)),
        });
    }
    // Gates that read the same state are decided by the same writers.
    let mut guards: Vec<Guard> = Vec::new();
    for (gate, reads) in guard_reads {
        let vars: Vec<String> = uniq(reads.iter().map(VarKey::name))
            .into_iter()
            .map(str::to_string)
            .collect();
        match guards.iter_mut().find(|g| g.vars == vars) {
            Some(g) => g.gate = format!("{}, {gate}", g.gate),
            None => guards.push(Guard {
                writers: writers_of(&reads),
                vars,
                gate,
            }),
        }
    }
    let upgrade_gate = order.iter().find_map(|c| {
        let k = &ix.cons[*c];
        let f = k
            .members("FunctionDefinition")
            .find(|f| s(f, "name") == "_authorizeUpgrade" && implemented(f))?;
        let d = Def {
            node: f,
            unit: k.unit,
            con: Some(*c),
        };
        let gates: Vec<String> = cx
            .modifiers(&d)
            .iter()
            .filter(|(inv, c)| cx.is_gate_call(inv, c, &Who::default()))
            .map(|(inv, _)| modifier_text(inv))
            .collect();
        let who = if !gates.is_empty() {
            gates.join(" and ")
        } else if cx.has_check(&d, &[]) {
            "a check in its body".to_string()
        } else {
            "nobody in particular".to_string()
        };
        Some((who, ix.at(k.unit, f)))
    });
    let mut runs = Found::default();
    let none = BTreeSet::new();
    for c in &order {
        let k = &ix.cons[*c];
        if matches!(k.kind, "library" | "interface") {
            continue;
        }
        for n in items(k.node, "nodes").iter().filter(|n| {
            matches!(
                s(n, "nodeType"),
                "FunctionDefinition" | "ModifierDefinition"
            )
        }) {
            walk(n.get("body").unwrap_or(&Value::Null), &mut |x| {
                note_call(ix, k.unit, x, &none, &mut runs);
            });
        }
    }
    // Library and free functions run in the contract's own context, so what
    // they call, the contract calls: `SignatureChecker` asking a wallet.
    let mut todo: Vec<Def> = Vec::new();
    for c in &order {
        let k = &ix.cons[*c];
        if matches!(k.kind, "library" | "interface") {
            continue;
        }
        for n in items(k.node, "nodes") {
            if matches!(
                s(n, "nodeType"),
                "FunctionDefinition" | "ModifierDefinition"
            ) {
                todo.push(Def {
                    node: n,
                    unit: k.unit,
                    con: Some(*c),
                });
            }
        }
    }
    let mut seen: BTreeSet<Ptr> = BTreeSet::new();
    let mut reached: Vec<Def> = Vec::new();
    let mut edges: Vec<(Def, Def, Vec<&Value>)> = Vec::new();
    while let Some(d) = todo.pop() {
        for (_, callee) in cx.modifiers(&d).iter().chain(cx.calls(&d).iter()) {
            let Callee::Def(cd, args) = callee else {
                continue;
            };
            if cd.con.is_none() || ix.is_library(cd) {
                edges.push((d, *cd, args.clone()));
                if seen.insert(ptr(cd.node)) {
                    reached.push(*cd);
                    todo.push(*cd);
                }
            }
        }
    }
    // A value every call passes as zero sends nothing: `functionCall` runs
    // `functionCallWithValue(target, data, 0, ...)`, whose `call{value: value}`
    // is then only a low-level call. Zero can come through a parameter too.
    let mut zero: BTreeMap<Ptr, Vec<bool>> = reached
        .iter()
        .map(|d| (ptr(d.node), vec![true; params(d.node).len()]))
        .collect();
    loop {
        let mut changed = false;
        for (from, to, args) in &edges {
            let from_params = &ix.locals(from.node).params;
            for (j, a) in args.iter().enumerate() {
                let passed_zero = is_zero(a)
                    || (s(a, "nodeType") == "Identifier"
                        && referenced(a)
                            .and_then(|id| from_params.iter().position(|p| *p == id))
                            .is_some_and(|i| {
                                zero.get(&ptr(from.node))
                                    .is_some_and(|z| z.get(i) == Some(&true))
                            }));
                if !passed_zero
                    && let Some(z) = zero.get_mut(&ptr(to.node))
                    && z.get(j) == Some(&true)
                {
                    z[j] = false;
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    for cd in &reached {
        let zeros: BTreeSet<i64> = ix
            .locals(cd.node)
            .params
            .iter()
            .zip(zero.get(&ptr(cd.node)).into_iter().flatten())
            .filter(|(_, z)| **z)
            .map(|(p, _)| *p)
            .collect();
        walk(cd.node.get("body").unwrap_or(&Value::Null), &mut |x| {
            note_call(ix, cd.unit, x, &zeros, &mut runs);
        });
    }
    let found: BTreeSet<&str> = functions.iter().map(|f| f.name.as_str()).collect();
    let abi = ix.units[con.unit]
        .abis
        .get(con.name)
        .cloned()
        .unwrap_or(Value::Null);
    let mut not_found: Vec<String> = entry_points(&abi)
        .into_iter()
        .filter(|n| !found.contains(n.as_str()))
        .collect();
    for f in abi.as_array().into_iter().flatten() {
        let kind = s(f, "type");
        if matches!(kind, "fallback" | "receive")
            && !found.contains(kind)
            && !not_found.iter().any(|n| n == kind)
        {
            not_found.push(kind.to_string());
        }
    }
    Contract {
        name: con.name.to_string(),
        file: ix.units[con.unit].path.clone(),
        bases: items(con.node, "baseContracts")
            .iter()
            .filter_map(|b| b.pointer("/baseName/name").and_then(Value::as_str))
            .map(str::to_string)
            .collect(),
        lineage: order[1..]
            .iter()
            .map(|c| ix.cons[*c].name.to_string())
            .collect(),
        unresolved: cx.lin.unresolved.clone(),
        state,
        functions,
        not_found,
        calls: runs.calls,
        upgradeable: upgrade_gate.is_some()
            || order[1..]
                .iter()
                .map(|c| ix.cons[*c].name)
                .chain(cx.lin.unresolved.iter().map(String::as_str))
                .any(|b| b.ends_with("Upgradeable") || b.ends_with("Initializable")),
        upgrade_gate,
        low_level: runs.low_level,
        sends: runs.sends,
        selfdestructs: runs.selfdestructs,
        guards,
        key: id_part(con.name),
        inherited_by: vec![],
    }
}

/// What the code a contract runs calls, sends and destroys, each with its line.
#[derive(Default)]
struct Found {
    /// `Type.member` of every call into another contract, first line only.
    calls: BTreeMap<String, String>,
    low_level: Vec<(String, String)>,
    sends: Vec<(String, String)>,
    selfdestructs: Vec<(String, String)>,
}

fn push_once(list: &mut Vec<(String, String)>, kind: &str, at: String) {
    let entry = (kind.to_string(), at);
    if !list.contains(&entry) {
        list.push(entry);
    }
}

// Records a call into another contract, a low-level call, ether sent or a
// `selfdestruct` at node `x`. `zeros` are the parameters every call passes
// as zero: a `call{value: v}` with one of them as `v` sends nothing.
fn note_call(ix: &Index, unit: usize, x: &Value, zeros: &BTreeSet<i64>, found: &mut Found) {
    if s(x, "nodeType") == "InlineAssembly" {
        let names = yul_calls(x);
        for kind in ["call", "delegatecall", "staticcall"] {
            if names.contains(kind) {
                push_once(
                    &mut found.low_level,
                    &format!("{kind} (assembly)"),
                    ix.at(unit, x),
                );
            }
        }
        if names.contains("selfdestruct") {
            push_once(
                &mut found.selfdestructs,
                "selfdestruct (assembly)",
                ix.at(unit, x),
            );
        }
        return;
    }
    if s(x, "nodeType") != "FunctionCall" {
        return;
    }
    if is_selfdestruct(x) {
        push_once(&mut found.selfdestructs, "selfdestruct", ix.at(unit, x));
        return;
    }
    let Some(mut e) = x.get("expression") else {
        return;
    };
    let mut value: Option<&Value> = None;
    // `t.call{value: v}(data)`, and before solc 0.6.2 `t.call.value(v)(data)`.
    loop {
        let inner = e.get("expression").unwrap_or(&Value::Null);
        match s(e, "nodeType") {
            "FunctionCallOptions" => {
                if let Some(j) = items(e, "names")
                    .iter()
                    .position(|n| n.as_str() == Some("value"))
                {
                    value = value.or(items(e, "options").get(j));
                }
                e = inner;
            }
            "FunctionCall"
                if s(inner, "nodeType") == "MemberAccess"
                    && matches!(s(inner, "memberName"), "value" | "gas") =>
            {
                if s(inner, "memberName") == "value" {
                    value = value.or(args_of(e).first());
                }
                e = inner.get("expression").unwrap_or(&Value::Null);
            }
            _ => break,
        }
    }
    if s(e, "nodeType") != "MemberAccess" {
        return;
    }
    let member = s(e, "memberName");
    let mut on = type_string(e.get("expression").unwrap_or(&Value::Null));
    // A library function attached to `address` is no builtin.
    let builtin = on.starts_with("address")
        && !type_id(e).contains("$bound_to$")
        && !type_id(e).contains("$attached_to$");
    if builtin && matches!(member, "transfer" | "send") {
        push_once(&mut found.sends, member, ix.at(unit, x));
        return;
    }
    let sends = value.is_some_and(|v| {
        !is_zero(v)
            && !(s(v, "nodeType") == "Identifier"
                && referenced(v).is_some_and(|id| zeros.contains(&id)))
    });
    if builtin && member == "call" && sends {
        push_once(&mut found.sends, "call", ix.at(unit, x));
        return;
    }
    // `SafeERC20.safeTransfer(token, ...)` calls the token.
    if on.starts_with("type(library ")
        && let Some(first) = args_of(x).first()
    {
        on = type_string(first);
    }
    // `super.f()` is inherited code, not another contract.
    if let Some(target) = on
        .strip_prefix("contract ")
        .filter(|t| !t.starts_with("super "))
    {
        found
            .calls
            .entry(format!("{target}.{member}"))
            .or_insert_with(|| ix.at(unit, x));
    } else if matches!(member, "call" | "delegatecall" | "staticcall") && on.starts_with("address")
    {
        found.low_level.push((member.to_string(), ix.at(unit, x)));
    }
}

/// Something the code implies that a person should decide on: an assumption
/// the protocol leans on, or an invariant worth a test.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub invariant: bool,
    /// A short id for the node it would become: `asm.token.minter-role`.
    pub id: String,
    pub title: String,
    pub detail: String,
    pub evidence: Vec<String>,
}

// A few names in full, the rest as a count: a title has to stay a title.
fn some(names: &[&str]) -> String {
    if names.len() <= 3 {
        names.join(", ")
    } else {
        format!("{}, {} and {} more", names[0], names[1], names.len() - 2)
    }
}

// Overloads share a name: once is enough wherever names are listed.
fn uniq<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let mut seen = BTreeSet::new();
    names.into_iter().filter(|n| seen.insert(*n)).collect()
}

// A name as part of an id: lowercase, dashes for anything else.
fn id_part(text: &str) -> String {
    let mut out = String::new();
    for c in text.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

// `onlyRole(MINTER_ROLE)` is known by its role; any other gate by its name.
fn gate_part(gate: &str) -> String {
    match gate.split_once('(') {
        Some((name, args)) if name.to_lowercase().ends_with("role") => id_part(args),
        Some((name, _)) => id_part(name),
        None => id_part(gate),
    }
}

impl Function {
    fn at(&self) -> String {
        format!("{}:{}", self.file, self.line)
    }

    fn is_initializer(&self) -> bool {
        self.others
            .iter()
            .any(|m| m.starts_with("initializer") || m.starts_with("reinitializer"))
    }

    // An initializer guarded by its own code (`require(!initialized)`, a
    // version check), known only by its name: `initialize`, `initializeV2`,
    // `init`, `init_v2`; not `initiate`. Whether it runs once is not read.
    fn is_hand_initializer(&self) -> bool {
        let n = self.name.as_str();
        self.gates.is_empty()
            && self.checks.is_empty()
            && !self.is_initializer()
            && (n.starts_with("initialize")
                || n.strip_prefix("init")
                    .is_some_and(|rest| !rest.starts_with(|c: char| c.is_ascii_lowercase())))
    }

    // Who gets through: its gates, or where its body checks.
    fn who(&self) -> String {
        if !self.gates.is_empty() {
            self.gates.join(", ")
        } else if !self.checks.is_empty() {
            format!(
                "checks the caller at {}",
                self.checks
                    .iter()
                    .map(|l| format!("{}:{l}", self.file))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        } else {
            "anyone".to_string()
        }
    }

    // One line of the report.
    fn line(&self) -> String {
        let mut line = format!("  {}:{} {}", self.file, self.line, self.name);
        line.push_str(&if self.gates.is_empty() {
            " - anyone".to_string()
        } else {
            format!(" - {}", self.gates.join(", "))
        });
        if !self.checks.is_empty() {
            let at: Vec<String> = self.checks.iter().map(|l| format!(":{l}")).collect();
            line.push_str(&format!(", checks the caller at {}", at.join(", ")));
        }
        if self.asm_store {
            line.push_str(", writes storage in assembly");
        }
        if !self.others.is_empty() {
            line.push_str(&format!(" [{}]", self.others.join(", ")));
        }
        line
    }
}

impl Contract {
    // Unresolved bases count too: their name is all that is known of them.
    fn has_base(&self, part: &str) -> bool {
        self.lineage
            .iter()
            .chain(&self.unresolved)
            .any(|b| b.contains(part))
    }

    // `Ownable`, `OwnableUpgradeable`, `Ownable2Step`; not `MultiOwnable`.
    fn has_standard(&self, prefix: &str) -> bool {
        self.lineage
            .iter()
            .chain(&self.unresolved)
            .any(|b| b.starts_with(prefix))
    }

    fn own(&self) -> impl Iterator<Item = &Function> {
        self.functions.iter().filter(|f| f.contract == self.name)
    }

    // Its own functions and those of the project's own bases.
    fn of_project(&self) -> impl Iterator<Item = &Function> {
        self.functions.iter().filter(|f| !f.library)
    }

    pub fn candidates(&self) -> Vec<Candidate> {
        let mut out = Vec::new();
        let c = &self.name;
        let k = &self.key;
        // Who is trusted with what: one assumption per gate.
        let mut by_gate: BTreeMap<&str, Vec<&Function>> = BTreeMap::new();
        for f in &self.functions {
            for g in &f.gates {
                by_gate.entry(g).or_default().push(f);
            }
        }
        for (gate, fs) in &by_gate {
            let names = uniq(fs.iter().map(|f| f.name.as_str()));
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.{}", gate_part(gate)),
                title: format!("{c}: whoever passes {gate} is trusted with {}", some(&names)),
                detail: format!(
                    "Nothing in the code limits what a caller that passes {gate} does with {}. Who holds it, and how that key is protected, is outside the code.",
                    names.join(", ")
                ),
                evidence: fs.iter().map(|f| f.at()).collect(),
            });
        }
        let gated: Vec<&Function> = self
            .of_project()
            .filter(|f| !f.gates.is_empty() || !f.checks.is_empty())
            .collect();
        if !gated.is_empty() {
            let each: Vec<String> = gated
                .iter()
                .map(|f| format!("{} ({})", f.name, f.who()))
                .collect();
            out.push(Candidate {
                invariant: true,
                id: format!("inv.{k}.access"),
                title: format!(
                    "{c}: each restricted function reverts for a caller that should not get through"
                ),
                detail: format!(
                    "Call each from an address that holds nothing and expect a revert: {}.",
                    uniq(each.iter().map(String::as_str)).join("; ")
                ),
                evidence: gated.iter().map(|f| f.at()).collect(),
            });
        }
        // Who passes a gate is itself state: whoever writes it decides who
        // gets through.
        let mut decided: BTreeSet<&str> = BTreeSet::new();
        for g in &self.guards {
            let (Some(first), false) = (g.vars.first(), g.writers.is_empty()) else {
                continue;
            };
            let writers: Vec<&str> = g.writers.iter().map(String::as_str).collect();
            let fs: Vec<&Function> = self
                .functions
                .iter()
                .filter(|f| writers.contains(&f.name.as_str()))
                .collect();
            let each: Vec<String> = fs
                .iter()
                .map(|f| format!("{} ({})", f.name, f.who()))
                .collect();
            decided.extend(g.vars.iter().map(String::as_str));
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.{}", id_part(first)),
                title: format!(
                    "{c}: {} {} who passes {} ({})",
                    some(&writers),
                    if writers.len() == 1 { "decides" } else { "decide" },
                    g.gate,
                    g.vars.join(", ")
                ),
                detail: format!(
                    "{} lets through whoever {} records, and these can change it: {}. Each is only as safe as who can call it.",
                    g.gate,
                    g.vars.join(", "),
                    uniq(each.iter().map(String::as_str)).join("; ")
                ),
                evidence: fs.iter().map(|f| f.at()).collect(),
            });
        }
        // Only when the code did not show who writes the roles.
        if self.has_standard("AccessControl") && !decided.contains("_roles") {
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.role-admin"),
                title: format!("{c}: whoever holds a role's admin role can give that role to anyone"),
                detail: "grantRole and revokeRole are inherited: DEFAULT_ADMIN_ROLE administers every role unless the code sets another admin, so each trusted role is only as safe as its admin.".into(),
                evidence: vec![self.file.clone()],
            });
        }
        if self.has_standard("Ownable") && !decided.contains("_owner") {
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.owner-transfer"),
                title: format!("{c}: the owner can hand ownership to anyone"),
                detail: "transferOwnership is inherited: everything the owner is trusted with moves with it.".into(),
                evidence: vec![self.file.clone()],
            });
        }
        // Overloads share a name and so an id: one candidate per name.
        let mut inits: BTreeMap<&str, (bool, Vec<String>)> = BTreeMap::new();
        for f in &self.functions {
            let by_modifier = f.gates.is_empty() && f.is_initializer();
            if by_modifier || f.is_hand_initializer() {
                let e = inits.entry(f.name.as_str()).or_default();
                e.0 |= by_modifier;
                e.1.push(f.at());
            }
        }
        for (name, (by_modifier, evidence)) in inits {
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.{}", id_part(name)),
                title: format!("{c}: {name} was called by the deployer before anyone else could"),
                detail: if by_modifier {
                    "It has no access check and runs once: whoever calls it first sets the roles. Check the deployment transaction of each proxy.".into()
                } else {
                    "It has no access check and no initializer modifier: its name says it initializes, and whether it can run only once rests on its own code (a flag or a version check), which this survey does not read. Whoever calls it first sets what it sets. Check the deployment transaction of each proxy, and that a second call reverts.".into()
                },
                evidence,
            });
        }
        if let Some((gate, at)) = &self.upgrade_gate {
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.upgrade"),
                title: format!("{c}: whoever passes {gate} can replace all of its logic"),
                detail: "The contract is upgradeable: an upgrade can change every rule the other nodes rely on, so each of them rests on this.".into(),
                evidence: vec![at.clone()],
            });
        }
        // Its own functions keep the rule they always had: no gate. An
        // inherited one is open only when it checks nothing either.
        let open: Vec<&Function> = self
            .functions
            .iter()
            .filter(|f| {
                f.gates.is_empty()
                    && !f.is_initializer()
                    && (f.contract == self.name || f.checks.is_empty())
            })
            .collect();
        if !open.is_empty() || !self.not_found.is_empty() {
            let names = uniq(
                open.iter()
                    .map(|f| f.name.as_str())
                    .chain(self.not_found.iter().map(String::as_str)),
            );
            let lines: Vec<String> = open.iter().filter(|f| !f.library).map(|f| f.at()).collect();
            out.push(Candidate {
                invariant: true,
                id: format!("inv.{k}.books"),
                title: format!("{c}: its books stay consistent whatever anyone calls"),
                detail: format!(
                    "Callable without a role of this contract's own: {}. This is the surface an invariant test's handler has to cover.",
                    names.join(", ")
                ),
                evidence: if lines.is_empty() {
                    vec![self.file.clone()]
                } else {
                    lines
                },
            });
        }
        // One assumption per contract it calls into, naming what it calls.
        let mut by_target: BTreeMap<&str, Vec<(&str, &str)>> = BTreeMap::new();
        for (call, at) in &self.calls {
            let (target, member) = call.split_once('.').unwrap_or((call, ""));
            by_target.entry(target).or_default().push((member, at));
        }
        for (target, members) in &by_target {
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.calls-{}", id_part(target)),
                title: format!(
                    "{c}: {target} behaves as its interface says ({})",
                    uniq(members.iter().map(|(m, _)| *m)).join(", ")
                ),
                detail: "The contract calls into another one and takes what it does and returns on trust. Where that address comes from is not read here: fixed at deployment, set by an admin, or given by the caller; each is a different trust, so check every call site.".into(),
                evidence: members.iter().map(|(_, at)| (*at).to_string()).collect(),
            });
        }
        let mut by_kind: BTreeMap<&str, Vec<String>> = BTreeMap::new();
        for (kind, at) in &self.low_level {
            by_kind.entry(kind).or_default().push(at.clone());
        }
        for (kind, at) in by_kind {
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.low-level-{}", id_part(kind)),
                title: format!("{c}: the target of its {kind} is trusted"),
                detail: "A low-level call runs whatever code is at the target address.".into(),
                evidence: at,
            });
        }
        if !self.selfdestructs.is_empty() {
            let by: Vec<String> = self
                .functions
                .iter()
                .filter(|f| f.selfdestruct)
                .map(|f| format!("{} ({})", f.name, f.who()))
                .collect();
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.selfdestruct"),
                title: format!("{c}: whoever reaches selfdestruct can remove its code (or, after Cancun, send away its ether)"),
                detail: if by.is_empty() {
                    "No entry point of its own was found to reach it: check the constructor and any code that runs it by delegatecall.".into()
                } else {
                    format!(
                        "Entry points that reach it: {}. Before Cancun it deletes the code and storage and sends all its ether to the address given; since Cancun it deletes them only in the transaction that created the contract, and otherwise only sends the ether.",
                        uniq(by.iter().map(String::as_str)).join("; ")
                    )
                },
                evidence: self.selfdestructs.iter().map(|(_, at)| at.clone()).collect(),
            });
        }
        if !self.sends.is_empty() {
            let kinds = uniq(self.sends.iter().map(|(k, _)| k.as_str()));
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.sends-ether"),
                title: format!("{c}: the addresses it sends ether to can receive it (and cannot reenter harmfully)"),
                detail: format!(
                    "It sends ether with {}. A receiver that reverts makes transfer revert and send return false; transfer and send forward 2300 gas, call forwards the rest, so a receiver reached by call runs its own code and can call back into this contract before the function ends.",
                    kinds.join(", ")
                ),
                evidence: self.sends.iter().map(|(_, at)| at.clone()).collect(),
            });
        }
        if self.has_base("ERC20") {
            out.push(Candidate {
                invariant: true,
                id: format!("inv.{k}.supply"),
                title: format!("{c}: totalSupply equals the sum of all balances"),
                detail: "The accounting every ERC-20 holder relies on; track the holders in the handler.".into(),
                evidence: vec![self.file.clone()],
            });
        }
        if self.has_base("Pausable") {
            out.push(Candidate {
                invariant: true,
                id: format!("inv.{k}.pause"),
                title: format!("{c}: while paused, nothing a pause is meant to stop goes through"),
                detail: "Pause, then try each function that should be stopped.".into(),
                evidence: vec![self.file.clone()],
            });
        }
        // Two facts on one line are one place to look.
        for c in &mut out {
            let mut seen = BTreeSet::new();
            c.evidence.retain(|e| seen.insert(e.clone()));
        }
        out
    }

    /// The names of the functions of its own and of the project's bases,
    /// then those it takes from libraries or could not resolve.
    pub fn names(&self) -> (Vec<String>, Vec<String>) {
        let own: Vec<&str> = uniq(self.of_project().map(|f| f.name.as_str()));
        let rest: Vec<&str> = uniq(
            self.functions
                .iter()
                .filter(|f| f.library)
                .map(|f| f.name.as_str())
                .chain(self.not_found.iter().map(String::as_str)),
        )
        .into_iter()
        .filter(|n| !own.contains(n))
        .collect();
        (
            own.into_iter().map(str::to_string).collect(),
            rest.into_iter().map(str::to_string).collect(),
        )
    }

    /// One line of counts, for a brief that has to stay short.
    pub fn summary(&self) -> String {
        let gated = self
            .functions
            .iter()
            .filter(|f| !f.gates.is_empty())
            .count();
        let checked = self
            .functions
            .iter()
            .filter(|f| f.gates.is_empty() && !f.checks.is_empty())
            .count();
        let open = self.functions.len() - gated - checked;
        let targets: BTreeSet<&str> = self
            .calls
            .keys()
            .map(|k| k.split_once('.').map_or(k.as_str(), |(t, _)| t))
            .collect();
        // Zero counts are left out: the brief is read on every start.
        let split: Vec<String> = [
            (gated, "gated"),
            (open, "open"),
            (checked, "open with a caller check"),
        ]
        .iter()
        .filter(|(n, _)| *n > 0)
        .map(|(n, what)| format!("{n} {what}"))
        .collect();
        let mut line = format!(
            "- {} ({}): {} entry points",
            self.name,
            self.file,
            self.functions.len()
        );
        if !split.is_empty() {
            line.push_str(&format!(" ({})", split.join(", ")));
        }
        if !self.not_found.is_empty() {
            line.push_str(&format!(", {} not resolved", self.not_found.len()));
        }
        line.push_str(&format!(
            ", {} state variables, {}, calls {} {}",
            self.state.len(),
            if self.upgrade_gate.is_some() {
                "upgradeable"
            } else {
                "no upgrade gate"
            },
            targets.len(),
            if targets.len() == 1 {
                "contract"
            } else {
                "contracts"
            }
        ));
        line
    }

    /// The facts, for a person or an agent to read before proposing anything.
    pub fn report(&self) -> String {
        let mut out = vec![format!("{} ({})", self.name, self.file)];
        if !self.bases.is_empty() {
            out.push(format!("  inherits: {}", self.bases.join(", ")));
        }
        if !self.inherited_by.is_empty() {
            out.push(format!(
                "  inherited by: {} (its code is reported there too)",
                self.inherited_by.join(", ")
            ));
        }
        out.extend(self.own().map(Function::line));
        out.extend(
            self.of_project()
                .filter(|f| f.contract != self.name)
                .map(|f| format!("{} (from {})", f.line(), f.contract)),
        );
        let mut from_libs: Vec<&Function> = self.functions.iter().filter(|f| f.library).collect();
        from_libs.sort_by(|a, b| a.name.cmp(&b.name));
        let libs = uniq_owned(from_libs.into_iter().map(|f| {
            let mut text = if !f.gates.is_empty() {
                format!("{} - {}", f.name, f.gates.join(", "))
            } else if !f.checks.is_empty() {
                format!("{} - checks the caller", f.name)
            } else {
                f.name.clone()
            };
            if f.asm_store {
                text.push_str(if text.contains(" - ") {
                    ", writes storage in assembly"
                } else {
                    " - anyone, writes storage in assembly"
                });
            }
            text
        }));
        if !libs.is_empty() {
            out.push(format!("  from libraries: {}", libs.join(", ")));
        }
        if !self.not_found.is_empty() {
            out.push(if self.unresolved.is_empty() {
                format!("  not resolved: {}", self.not_found.join(", "))
            } else {
                format!(
                    "  not resolved (source of a base contract was not found: {}): {}",
                    self.unresolved.join(", "),
                    self.not_found.join(", ")
                )
            });
        }
        // Behind a proxy a constructor and initial values only ever write
        // the implementation's own storage.
        let deployed = if self.upgradeable {
            "set in the implementation's constructor (not in the proxy's storage)"
        } else {
            "set at deployment"
        };
        for v in &self.state {
            let mut how = if !v.fixed.is_empty() {
                v.fixed.to_string()
            } else if !v.writers.is_empty() {
                format!("written by {}", v.writers.join(", "))
            } else if !v.hooks.is_empty() {
                format!(
                    "written inside {} (run by inherited code)",
                    v.hooks.join(", ")
                )
            } else if v.at_deployment {
                format!("{deployed}, never after")
            } else {
                "never written by this contract's own code".to_string()
            };
            if v.at_deployment
                && v.fixed.is_empty()
                && (!v.writers.is_empty() || !v.hooks.is_empty())
            {
                how.push_str(&format!(", {deployed}"));
            }
            let from = if v.contract == self.name {
                String::new()
            } else {
                format!(" (from {})", v.contract)
            };
            out.push(format!(
                "  {}:{} state {} - {how}{from}",
                v.file, v.line, v.name
            ));
        }
        if let Some((gate, at)) = &self.upgrade_gate {
            out.push(format!("  {at} upgradeable by {gate}"));
        }
        for (call, at) in &self.calls {
            out.push(format!("  {at} calls {call}"));
        }
        for (kind, at) in &self.low_level {
            out.push(format!("  {at} low-level {kind}"));
        }
        for (kind, at) in &self.sends {
            out.push(format!("  {at} sends ether ({kind})"));
        }
        for (kind, at) in &self.selfdestructs {
            out.push(format!("  {at} {kind}"));
        }
        out.join("\n")
    }
}

fn uniq_owned(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    names
        .into_iter()
        .filter(|n| seen.insert(n.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn unit(path: &str, nodes: Vec<Value>, abis: Value, source: &str) -> Unit {
        Unit {
            path: path.to_string(),
            ast: json!({ "absolutePath": path, "nodes": nodes }),
            abis: abis
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            source: source.to_string(),
        }
    }

    fn project(f: &str) -> bool {
        f.starts_with("src/")
    }

    fn named<'a>(cs: &'a [Contract], name: &str) -> &'a Contract {
        cs.iter().find(|c| c.name == name).expect(name)
    }

    // The shape solc writes, cut down to what is read.
    fn token() -> Contract {
        let source = "contract Token {\n  function mint() {}\n  function pause() {}\n  function sweep() {}\n  function _authorizeUpgrade() {}\n}\n";
        let at = |needle: &str| format!("{}:1:0", source.find(needle).expect("in source"));
        let gate = |role: &str| {
            json!({ "modifierName": { "name": "onlyRole" },
                    "arguments": [{ "nodeType": "Identifier", "name": role }] })
        };
        let func = |name: &str, vis: &str, mods: Value, body: Value| {
            json!({ "nodeType": "FunctionDefinition", "kind": "function", "name": name,
                    "visibility": vis, "stateMutability": "nonpayable", "modifiers": mods,
                    "src": at(&format!("function {name}")), "body": body })
        };
        let oracle_call = json!({ "statements": [{ "nodeType": "FunctionCall",
            "src": at("function sweep"),
            "expression": { "nodeType": "MemberAccess", "memberName": "latestAnswer",
                "expression": { "typeDescriptions": { "typeString": "contract IOracle" } } } }] });
        let nodes = vec![
            json!({ "nodeType": "ContractDefinition", "name": "IOracle", "contractKind": "interface", "nodes": [] }),
            json!({ "nodeType": "ContractDefinition", "name": "Token", "contractKind": "contract", "abstract": false,
              "baseContracts": [{ "baseName": { "name": "ERC20Upgradeable" } }, { "baseName": { "name": "UUPSUpgradeable" } }],
              "nodes": [
                func("mint", "public", json!([gate("MINTER_ROLE")]), json!({})),
                func("pause", "external", json!([gate("PAUSER_ROLE"), { "modifierName": { "name": "nonReentrant" } }]), json!({})),
                func("sweep", "external", json!([]), oracle_call),
                func("_authorizeUpgrade", "internal", json!([gate("UPGRADER_ROLE")]), json!({})),
              ] }),
        ];
        let abi = json!({ "Token": [
            { "type": "function", "name": "mint", "stateMutability": "nonpayable" },
            { "type": "function", "name": "pause", "stateMutability": "nonpayable" },
            { "type": "function", "name": "sweep", "stateMutability": "nonpayable" },
            { "type": "function", "name": "transfer", "stateMutability": "nonpayable" },
            { "type": "function", "name": "balanceOf", "stateMutability": "view" }
        ]});
        let cs = read(&[unit("src/Token.sol", nodes, abi, source)], &project);
        assert_eq!(cs.len(), 1, "an interface is no target");
        cs[0].clone()
    }

    #[test]
    fn reads_who_may_call_what_and_where() {
        let c = token();
        assert_eq!(c.file, "src/Token.sol");
        let got: Vec<(&str, usize, Vec<String>)> = c
            .functions
            .iter()
            .map(|f| (f.name.as_str(), f.line, f.gates.clone()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("mint", 2, vec!["onlyRole(MINTER_ROLE)".to_string()]),
                ("pause", 3, vec!["onlyRole(PAUSER_ROLE)".to_string()]),
                ("sweep", 4, vec![]),
            ]
        );
        assert_eq!(c.functions[1].others, vec!["nonReentrant"]);
        assert_eq!(
            c.upgrade_gate,
            Some(("onlyRole(UPGRADER_ROLE)".into(), "src/Token.sol:5".into()))
        );
        assert_eq!(
            c.calls.get("IOracle.latestAnswer").map(String::as_str),
            Some("src/Token.sol:4")
        );
    }

    #[test]
    fn sums_a_contract_up_in_one_line() {
        assert_eq!(
            token().summary(),
            "- Token (src/Token.sol): 3 entry points (2 gated, 1 open), 1 not resolved, 0 state variables, upgradeable, calls 1 contract"
        );
    }

    #[test]
    fn an_unresolved_base_leaves_its_functions_to_the_abi_with_a_notice() {
        let c = token();
        assert_eq!(c.unresolved, vec!["ERC20Upgradeable", "UUPSUpgradeable"]);
        assert_eq!(c.not_found, vec!["transfer"]);
        let report = c.report();
        assert!(
            report.contains("  not resolved (source of a base contract was not found: ERC20Upgradeable, UUPSUpgradeable): transfer\n"),
            "{report}"
        );
        assert_eq!(c.names().1, vec!["transfer"]);
        let books = c
            .candidates()
            .into_iter()
            .find(|k| k.id == "inv.token.books")
            .expect("books");
        assert!(books.detail.contains("sweep, transfer"), "{}", books.detail);
    }

    #[test]
    fn a_modifier_that_never_looks_at_the_caller_is_no_access_check() {
        let source = "contract C {\n  function f() {}\n}\n";
        // No `referencedDeclaration` on the invocations: found by name.
        let modifier = |name: &str, body: Value| json!({ "nodeType": "ModifierDefinition", "id": name.len(), "name": name, "body": body });
        let uses = |name: &str| json!({ "modifierName": { "name": name }, "arguments": [] });
        let nodes = vec![
            json!({ "nodeType": "ContractDefinition", "name": "C", "contractKind": "contract", "nodes": [
            // Named like a gate, but it only checks its argument.
            modifier("onlyMintableToken", json!({ "x": { "nodeType": "Identifier", "name": "token" } })),
            // Named like a gate, but it only calls another contract.
            modifier("onlyListed", json!({ "x": { "nodeType": "FunctionCall",
                "expression": { "nodeType": "MemberAccess", "memberName": "isListed", "referencedDeclaration": 999,
                    "expression": { "nodeType": "Identifier", "name": "registry" } } } })),
            // Not named like one, but it checks msg.sender.
            modifier("keeper", json!({ "x": { "nodeType": "FunctionCall", "src": "0:1:0",
                "expression": { "nodeType": "Identifier", "name": "require" },
                "arguments": [{ "nodeType": "MemberAccess", "memberName": "sender",
                    "expression": { "nodeType": "Identifier", "name": "msg" } }] } })),
            { "nodeType": "FunctionDefinition", "kind": "function", "name": "f", "visibility": "external",
              "stateMutability": "nonpayable", "src": "15:1:0", "body": {},
              "modifiers": [uses("onlyMintableToken"), uses("onlyListed"), uses("keeper"), uses("onlyOwner"),
                uses("onlyInitializing"), uses("restricted")] }
        ] }),
        ];
        let cs = read(&[unit("src/C.sol", nodes, json!({}), source)], &project);
        assert_eq!(
            cs[0].functions[0].gates,
            vec!["keeper", "onlyOwner", "restricted"]
        );
        assert_eq!(
            cs[0].functions[0].others,
            vec!["onlyMintableToken", "onlyListed", "onlyInitializing"]
        );
    }

    #[test]
    fn says_what_can_change_each_state_variable() {
        let ident = |id: i64, name: &str| json!({ "nodeType": "Identifier", "name": name, "referencedDeclaration": id });
        let assign = |target: Value| json!({ "nodeType": "Assignment", "leftHandSide": target });
        let var = |id: i64, name: &str, extra: Value| {
            let mut v = json!({ "nodeType": "VariableDeclaration", "stateVariable": true,
                                "id": id, "name": name, "src": "0:1:0" });
            for (k, x) in extra.as_object().into_iter().flatten() {
                v[k] = x.clone();
            }
            v
        };
        let func = |id: i64, kind: &str, name: &str, vis: &str, body: Value| {
            json!({ "nodeType": "FunctionDefinition", "id": id, "kind": kind, "name": name,
                    "visibility": vis, "stateMutability": "nonpayable", "modifiers": [],
                    "src": "0:1:0", "body": body })
        };
        // `Config storage c = minted[key]; c.amount = x;` writes `minted`.
        let through_pointer = json!({ "statements": [
            { "nodeType": "VariableDeclarationStatement",
              "declarations": [{ "nodeType": "VariableDeclaration", "id": 20, "storageLocation": "storage" }],
              "initialValue": { "nodeType": "IndexAccess", "baseExpression": ident(2, "minted") } },
            assign(json!({ "nodeType": "MemberAccess", "memberName": "amount", "expression": ident(20, "c") }))
        ]});
        let calls_account = json!({ "statements": [
            { "nodeType": "FunctionCall", "expression": ident(12, "_account") }
        ]});
        let bump = json!({ "statements": [
            { "nodeType": "UnaryOperation", "operator": "++", "subExpression": ident(5, "last") }
        ]});
        let nodes = vec![
            json!({ "nodeType": "ContractDefinition", "name": "C", "contractKind": "contract", "nodes": [
            var(1, "limit", json!({})),
            var(2, "minted", json!({})),
            var(3, "ROLE", json!({ "constant": true })),
            var(4, "owner", json!({})),
            var(5, "last", json!({})),
            var(6, "token", json!({ "mutability": "immutable" })),
            var(7, "unused", json!({})),
            var(8, "fee", json!({ "value": { "nodeType": "Literal", "value": "5" } })),
            func(10, "function", "setLimit", "external", json!({ "s": [assign(ident(1, "limit"))] })),
            func(11, "function", "mint", "external", calls_account),
            func(12, "function", "_account", "internal", through_pointer),
            func(13, "constructor", "", "public", json!({ "s": [assign(ident(4, "owner")), assign(ident(1, "limit"))] })),
            func(14, "function", "_update", "internal", bump),
        ] }),
        ];
        let cs = read(
            &[unit("src/C.sol", nodes, json!({}), "contract C {}\n")],
            &project,
        );
        let c = &cs[0];
        let by_name = |n: &str| c.state.iter().find(|v| v.name == n).expect("variable");
        assert_eq!(by_name("limit").writers, vec!["setLimit"]);
        assert_eq!(by_name("minted").writers, vec!["mint"]);
        assert_eq!(by_name("ROLE").fixed, "constant");
        assert_eq!(by_name("token").fixed, "immutable");
        assert!(by_name("owner").at_deployment && by_name("owner").writers.is_empty());
        assert_eq!(by_name("last").hooks, vec!["_update"]);
        let report = c.report();
        assert!(
            report.contains("state limit - written by setLimit, set at deployment\n"),
            "{report}"
        );
        assert!(report.contains("state owner - set at deployment, never after"));
        assert!(report.contains("state fee - set at deployment, never after"));
        assert!(report.contains("state last - written inside _update (run by inherited code)"));
        assert!(report.contains("state unused - never written by this contract's own code"));
    }

    #[test]
    fn turns_the_facts_into_candidates_with_their_lines() {
        let c = token();
        let cands = c.candidates();
        let titles: Vec<&str> = cands.iter().map(|c| c.title.as_str()).collect();
        assert!(
            titles.contains(&"Token: whoever passes onlyRole(MINTER_ROLE) is trusted with mint")
        );
        assert!(titles.contains(
            &"Token: whoever passes onlyRole(UPGRADER_ROLE) can replace all of its logic"
        ));
        assert!(titles.contains(&"Token: IOracle behaves as its interface says (latestAnswer)"));
        assert!(titles.contains(&"Token: its books stay consistent whatever anyone calls"));
        assert!(titles.contains(
            &"Token: each restricted function reverts for a caller that should not get through"
        ));
        assert!(titles.contains(&"Token: totalSupply equals the sum of all balances"));
        let mint = cands
            .iter()
            .find(|c| c.title.contains("is trusted with mint"))
            .expect("mint");
        assert!(!mint.invariant);
        assert_eq!(mint.id, "asm.token.minter-role");
        assert_eq!(mint.evidence, vec!["src/Token.sol:2"]);
        let ids: Vec<&str> = cands.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"asm.token.upgrade") && ids.contains(&"asm.token.calls-ioracle"));
        // No two candidates of a contract ask for the same id.
        let unique: BTreeSet<&str> = ids.iter().copied().collect();
        assert_eq!(unique.len(), ids.len());
        assert!(c.report().contains("src/Token.sol:4 sweep - anyone"));
    }

    // Small AST pieces, each at a line of a source with one line per number.
    fn at(line: usize) -> String {
        format!("{}:1:0", 2 * (line - 1))
    }
    fn id(name: &str, refd: i64) -> Value {
        json!({ "nodeType": "Identifier", "name": name, "referencedDeclaration": refd })
    }
    fn sender() -> Value {
        json!({ "nodeType": "MemberAccess", "memberName": "sender",
                "expression": { "nodeType": "Identifier", "name": "msg" } })
    }
    fn index(base: Value, key: Value) -> Value {
        json!({ "nodeType": "IndexAccess", "baseExpression": base, "indexExpression": key })
    }
    fn bin(op: &str, l: Value, r: Value) -> Value {
        json!({ "nodeType": "BinaryOperation", "operator": op, "leftExpression": l, "rightExpression": r })
    }
    fn not(e: Value) -> Value {
        json!({ "nodeType": "UnaryOperation", "operator": "!", "subExpression": e })
    }
    fn lit(v: &str) -> Value {
        json!({ "nodeType": "Literal", "value": v })
    }
    fn call(f: Value, args: Vec<Value>, line: usize) -> Value {
        json!({ "nodeType": "FunctionCall", "kind": "functionCall", "expression": f,
                "arguments": args, "src": at(line) })
    }
    fn stmt(e: Value) -> Value {
        json!({ "nodeType": "ExpressionStatement", "expression": e })
    }
    fn require(cond: Value, line: usize) -> Value {
        call(id("require", -18), vec![cond], line)
    }
    fn revert_if(cond: Value, line: usize) -> Value {
        json!({ "nodeType": "IfStatement", "src": at(line), "condition": cond,
                "trueBody": { "nodeType": "RevertStatement" } })
    }
    fn address(arg: Value) -> Value {
        json!({ "nodeType": "FunctionCall", "kind": "typeConversion", "arguments": [arg],
                "expression": { "nodeType": "ElementaryTypeNameExpression", "typeName": { "name": "address" } } })
    }
    fn local(decl: i64, ty: &str, init: Value) -> Value {
        json!({ "nodeType": "VariableDeclarationStatement", "initialValue": init,
                "declarations": [{ "nodeType": "VariableDeclaration", "id": decl,
                                   "typeDescriptions": { "typeString": ty } }] })
    }
    fn body(statements: Vec<Value>) -> Value {
        json!({ "nodeType": "Block", "statements": statements })
    }
    fn func(fid: i64, name: &str, vis: &str, line: usize, mods: Value, b: Value) -> Value {
        json!({ "nodeType": "FunctionDefinition", "id": fid, "kind": "function", "name": name,
                "visibility": vis, "stateMutability": "nonpayable", "modifiers": mods,
                "src": at(line), "body": b })
    }
    // A function with parameters, each `(id, name, storage)`.
    fn with_params(mut f: Value, ps: &[(i64, &str, bool)]) -> Value {
        f["parameters"] = json!({ "parameters": ps.iter().map(|(i, n, st)| json!({
            "nodeType": "VariableDeclaration", "id": i, "name": n,
            "storageLocation": if *st { "storage" } else { "default" } })).collect::<Vec<_>>() });
        f
    }
    fn modifier(mid: i64, name: &str, ps: &[(i64, &str, bool)], b: Value) -> Value {
        let mut m = with_params(json!({}), ps);
        m["nodeType"] = json!("ModifierDefinition");
        m["id"] = json!(mid);
        m["name"] = json!(name);
        m["body"] = b;
        m
    }
    fn uses(name: &str, refd: i64) -> Value {
        json!({ "modifierName": { "nodeType": "Identifier", "name": name, "referencedDeclaration": refd } })
    }
    fn uses_with(name: &str, args: Vec<Value>) -> Value {
        json!({ "modifierName": { "nodeType": "IdentifierPath", "name": name }, "arguments": args })
    }
    fn contract(name: &str, bases: &[&str], nodes: Vec<Value>) -> Value {
        json!({ "nodeType": "ContractDefinition", "name": name, "contractKind": "contract",
                "baseContracts": bases.iter().map(|b| json!({ "baseName": { "name": b } })).collect::<Vec<_>>(),
                "nodes": nodes })
    }
    fn import(path: &str, symbols: &[(&str, Option<&str>)], unit_alias: &str) -> Value {
        json!({ "nodeType": "ImportDirective", "absolutePath": path, "unitAlias": unit_alias,
                "symbolAliases": symbols.iter().map(|(f, l)| json!({
                    "foreign": { "nodeType": "Identifier", "name": f }, "local": l })).collect::<Vec<_>>() })
    }
    fn file(path: &str, nodes: Vec<Value>) -> Unit {
        unit(path, nodes, json!({}), &"x\n".repeat(80))
    }
    fn read_one(contracts: Vec<Value>, name: &str) -> Contract {
        named(&read(&[file("src/vat.sol", contracts)], &project), name).clone()
    }
    fn assign(target: Value) -> Value {
        json!({ "nodeType": "Assignment", "operator": "=", "leftHandSide": target, "rightHandSide": lit("1") })
    }

    // Vat-like: `auth` on `wards`, and checks of the caller in the bodies.
    fn vat() -> Value {
        let wards = |key: Value| index(id("wards", 1), key);
        let allowed = |line: usize| {
            json!({ "nodeType": "IfStatement", "src": at(line),
                    "condition": bin("&&", bin("!=", id("src", 90), sender()),
                                     bin("!=", index(index(id("allowance", 3), id("src", 90)), sender()), lit("1"))),
                    "trueBody": body(vec![require(bin(">=", id("x", 91), id("wad", 92)), line + 1)]) })
        };
        let assembly = json!({ "nodeType": "InlineAssembly", "src": at(40), "AST": { "nodeType": "YulBlock",
            "statements": [{ "nodeType": "YulFunctionCall", "functionName": { "name": "caller" } },
                           { "nodeType": "YulFunctionCall", "functionName": { "name": "revert" } }] } });
        let none = json!([]);
        let auth = json!([uses("auth", 50)]);
        json!({ "nodeType": "ContractDefinition", "name": "Vat", "contractKind": "contract", "nodes": [
            { "nodeType": "VariableDeclaration", "id": 1, "name": "wards", "src": at(2) },
            { "nodeType": "VariableDeclaration", "id": 2, "name": "can", "src": at(3) },
            { "nodeType": "VariableDeclaration", "id": 4, "name": "owner", "src": at(4) },
            { "nodeType": "ModifierDefinition", "id": 50, "name": "auth",
              "body": body(vec![require(bin("==", wards(sender()), lit("1")), 6)]) },
            func(60, "_auth", "internal", 7, none.clone(),
                 body(vec![require(bin("==", sender(), id("owner", 4)), 8)])),
            func(10, "rely", "external", 10, auth.clone(), body(vec![assign(wards(id("usr", 93)))])),
            func(11, "deny", "external", 11, auth.clone(), body(vec![assign(wards(id("usr", 93)))])),
            func(12, "file", "external", 12, auth.clone(), body(vec![])),
            with_params(func(13, "file", "external", 13, auth.clone(), body(vec![])), &[(95, "what", false)]),
            func(14, "hope", "external", 14, none.clone(),
                 body(vec![assign(index(index(id("can", 2), sender()), id("usr", 93)))])),
            func(15, "flux", "external", 15, none.clone(),
                 body(vec![require(call(id("wish", 61), vec![id("src", 90), sender()], 16), 16)])),
            // `address u = msg.sender; require(balanceOf[u] >= rad)`: an amount.
            func(17, "heal", "external", 17, none.clone(),
                 body(vec![local(80, "address", sender()),
                           require(bin(">=", index(id("balanceOf", 5), id("u", 80)), id("rad", 94)), 18)])),
            func(19, "burn", "external", 19, none.clone(), body(vec![allowed(20)])),
            func(22, "kill", "external", 22, none.clone(),
                 body(vec![require(bin("!=", address(sender()), address(lit("0"))), 23)])),
            func(24, "own", "external", 24, none.clone(),
                 body(vec![local(81, "bool", bin("==", sender(), id("owner", 4))),
                           require(id("ok", 81), 25)])),
            func(26, "alias", "external", 26, none.clone(),
                 body(vec![local(82, "address payable", json!({ "nodeType": "FunctionCall", "kind": "typeConversion",
                               "arguments": [sender()], "typeDescriptions": { "typeString": "address payable" },
                               "expression": { "nodeType": "ElementaryTypeNameExpression", "typeName": { "name": "address", "stateMutability": "payable" } } })),
                           require(bin("==", id("u", 82), id("owner", 4)), 27)])),
            func(28, "local", "external", 28, none.clone(),
                 body(vec![stmt(call(id("_auth", 60), vec![], 29))])),
            func(30, "viaPublic", "external", 30, none.clone(),
                 body(vec![call(id("burn", 19), vec![sender()], 31)])),
            // The standard check, with its source not found.
            func(32, "std", "external", 32, none.clone(),
                 body(vec![stmt(call(id("_checkOwner", 999), vec![], 33))])),
            func(34, "banned", "external", 34, none.clone(),
                 body(vec![require(not(index(id("banned", 6), sender())), 35),
                           revert_if(bin("==", sender(), id("bad", 7)), 36)])),
            func(37, "early", "external", 37, none.clone(),
                 body(vec![json!({ "nodeType": "IfStatement", "src": at(38),
                                   "condition": bin("==", sender(), id("owner", 4)),
                                   "trueBody": { "nodeType": "Return" } }),
                           json!({ "nodeType": "RevertStatement" })])),
            func(39, "asm", "external", 39, none.clone(), body(vec![assembly])),
        ] })
    }

    #[test]
    fn finds_the_caller_checks_inside_a_body() {
        let c = read_one(vec![vat()], "Vat");
        let checks = |n: &str| {
            c.functions
                .iter()
                .find(|f| f.name == n)
                .map(|f| f.checks.clone())
                .expect("function")
        };
        assert_eq!(checks("hope"), Vec::<usize>::new());
        assert_eq!(checks("flux"), vec![16]);
        assert_eq!(checks("heal"), Vec::<usize>::new());
        assert_eq!(checks("burn"), vec![20]);
        assert_eq!(checks("kill"), Vec::<usize>::new());
        assert_eq!(checks("own"), vec![25]);
        assert_eq!(checks("alias"), vec![27]);
        assert_eq!(checks("local"), vec![29]);
        assert_eq!(checks("viaPublic"), Vec::<usize>::new());
        assert_eq!(checks("std"), vec![33]);
        // A deny-list stops some callers and trusts nobody.
        assert_eq!(checks("banned"), Vec::<usize>::new());
        assert_eq!(checks("early"), vec![38]);
        assert_eq!(checks("asm"), vec![40]);
        let report = c.report();
        assert!(
            report.contains("src/vat.sol:15 flux - anyone, checks the caller at :16"),
            "{report}"
        );
        assert!(
            report.contains("src/vat.sol:14 hope - anyone\n"),
            "{report}"
        );
        // One line per overload in the report.
        assert!(report.contains("src/vat.sol:12 file - auth\n  src/vat.sol:13 file - auth"));
        assert!(
            report.contains("state wards - written by rely, deny\n"),
            "{report}"
        );
    }

    fn ret(e: Value) -> Value {
        json!({ "nodeType": "Return", "expression": e })
    }

    // Morpho-like: a helper whose result, not its body, checks the caller.
    #[test]
    fn a_call_whose_result_is_computed_from_the_caller_is_a_check() {
        let none = json!([]);
        let helper = |fid: i64, name: &str, ps: &[(i64, &str, bool)], e: Value| {
            with_params(
                func(
                    fid,
                    name,
                    "internal",
                    fid as usize - 60,
                    none.clone(),
                    body(vec![ret(e)]),
                ),
                ps,
            )
        };
        let entry = |fid: i64, name: &str, line: usize, stmts: Vec<Value>| {
            with_params(
                func(fid, name, "external", line, none.clone(), body(stmts)),
                &[(fid + 100, "onBehalf", false)],
            )
        };
        let on = |fid: i64| id("onBehalf", fid + 100);
        let c = read_one(
            vec![
                json!({ "nodeType": "ContractDefinition", "name": "Morpho", "contractKind": "contract", "nodes": [
            { "nodeType": "VariableDeclaration", "id": 3, "name": "isAuthorized", "src": at(2) },
            { "nodeType": "VariableDeclaration", "id": 4, "name": "balance", "src": at(3) },
            { "nodeType": "VariableDeclaration", "id": 5, "name": "blacklisted", "src": at(4) },
            // return msg.sender == onBehalf || isAuthorized[onBehalf][msg.sender];
            helper(65, "_isSenderAuthorized", &[(200, "onBehalf", false)],
                   bin("||", bin("==", sender(), id("onBehalf", 200)),
                       index(index(id("isAuthorized", 3), id("onBehalf", 200)), sender()))),
            // An amount: return balance[msg.sender] >= x;
            helper(66, "_enough", &[(201, "x", false)],
                   bin(">=", index(id("balance", 4), sender()), id("x", 201))),
            // A deny-list: return !blacklisted[msg.sender];
            helper(67, "_notBlocked", &[], not(index(id("blacklisted", 5), sender()))),
            helper(68, "_isBlocked", &[(202, "a", false)], index(id("blacklisted", 5), id("a", 202))),
            // Through another helper, with the caller handed in.
            helper(69, "_mayAct", &[(203, "a", false), (204, "u", false)],
                   call(id("_isSenderAuthorized", 65), vec![id("a", 203)], 9)),
            entry(20, "withdraw", 20, vec![require(call(id("_isSenderAuthorized", 65), vec![on(20)], 21), 21)]),
            entry(22, "borrow", 22, vec![local(80, "bool", call(id("_isSenderAuthorized", 65), vec![on(22)], 23)),
                                         require(id("ok", 80), 24)]),
            entry(25, "repay", 25, vec![revert_if(not(call(id("_mayAct", 69), vec![on(25), sender()], 26)), 26)]),
            entry(27, "take", 27, vec![require(call(id("_enough", 66), vec![lit("1")], 28), 28)]),
            entry(29, "send", 29, vec![require(call(id("_notBlocked", 67), vec![], 30), 30)]),
            entry(31, "pass", 31, vec![require(not(call(id("_isBlocked", 68), vec![sender()], 32)), 32),
                                       revert_if(call(id("_isBlocked", 68), vec![sender()], 33), 33)]),
        ] }),
            ],
            "Morpho",
        );
        let checks = |n: &str| {
            c.functions
                .iter()
                .find(|f| f.name == n)
                .map(|f| f.checks.clone())
                .expect("function")
        };
        assert_eq!(checks("withdraw"), vec![21]);
        assert_eq!(checks("borrow"), vec![24]);
        assert_eq!(checks("repay"), vec![26]);
        assert_eq!(checks("take"), Vec::<usize>::new());
        assert_eq!(checks("send"), Vec::<usize>::new());
        assert_eq!(checks("pass"), Vec::<usize>::new());
        let report = c.report();
        assert!(
            report.contains("src/vat.sol:20 withdraw - anyone, checks the caller at :21\n"),
            "{report}"
        );
        assert!(
            report.contains("src/vat.sol:27 take - anyone\n"),
            "{report}"
        );
    }

    // Handing the caller to a helper is no check unless the helper checks it
    // or returns a value computed from it.
    #[test]
    fn the_caller_handed_to_a_helper_that_only_compares_amounts_is_no_check() {
        let none = json!([]);
        let entry = |fid: i64, name: &str, stmts: Vec<Value>| {
            func(
                fid,
                name,
                "external",
                fid as usize,
                none.clone(),
                body(stmts),
            )
        };
        let enough = |line: usize| call(id("_enough", 60), vec![sender(), lit("1")], line);
        let mut wish = call(id("_wish", 62), vec![sender()], 28);
        wish["typeDescriptions"] = json!({ "typeString": "bool" });
        let c = read_one(
            vec![
                json!({ "nodeType": "ContractDefinition", "name": "Vault", "contractKind": "contract", "nodes": [
            { "nodeType": "VariableDeclaration", "id": 3, "name": "bal", "src": at(2) },
            { "nodeType": "VariableDeclaration", "id": 4, "name": "owner", "src": at(3) },
            // return bal[a] >= x;
            with_params(func(60, "_enough", "internal", 5, none.clone(),
                             body(vec![ret(bin(">=", index(id("bal", 3), id("a", 200)), id("x", 201)))])),
                        &[(200, "a", false), (201, "x", false)]),
            // require(a == owner); return true;
            with_params(func(61, "_isOwner", "internal", 6, none.clone(),
                             body(vec![require(bin("==", id("a", 202), id("owner", 4)), 6), ret(lit("true"))])),
                        &[(202, "a", false)]),
            entry(20, "take", vec![require(enough(21), 21)]),
            entry(22, "keep", vec![local(80, "bool", enough(23)), require(id("ok", 80), 24)]),
            entry(25, "admin", vec![require(call(id("_isOwner", 61), vec![sender()], 26), 26)]),
            // return a == owner;
            with_params(func(62, "_wish", "internal", 7, none.clone(),
                             body(vec![ret(bin("==", id("a", 203), id("owner", 4)))])),
                        &[(203, "a", false)]),
            // assembly { z := or(x, y) }
            with_params(func(63, "_either", "internal", 8, none.clone(),
                             body(vec![json!({ "nodeType": "InlineAssembly", "operations": "{ z := or(x, y) }" })])),
                        &[(204, "x", false), (205, "y", false)]),
            entry(27, "consent", vec![require(call(id("_either", 63), vec![lit("false"), wish], 28), 28)]),
        ] }),
            ],
            "Vault",
        );
        let checks = |n: &str| {
            c.functions
                .iter()
                .find(|f| f.name == n)
                .map(|f| f.checks.clone())
                .expect("function")
        };
        assert_eq!(checks("take"), Vec::<usize>::new());
        assert_eq!(checks("keep"), Vec::<usize>::new());
        assert_eq!(checks("admin"), vec![26]);
        assert_eq!(checks("consent"), vec![28]);
    }

    #[test]
    fn names_who_decides_who_passes_a_gate_once_per_overload() {
        let c = read_one(vec![vat()], "Vat");
        let cands = c.candidates();
        let by_id = |i: &str| cands.iter().find(|c| c.id == i).expect(i);
        let wards = by_id("asm.vat.wards");
        assert_eq!(
            wards.title,
            "Vat: rely, deny decide who passes auth (wards)"
        );
        assert!(
            wards.detail.contains("rely (auth); deny (auth)"),
            "{}",
            wards.detail
        );
        assert_eq!(wards.evidence, vec!["src/vat.sol:10", "src/vat.sol:11"]);
        assert_eq!(
            by_id("asm.vat.auth").title,
            "Vat: whoever passes auth is trusted with rely, deny, file"
        );
        let access = by_id("inv.vat.access");
        assert!(
            access
                .detail
                .contains("file (auth); flux (checks the caller at src/vat.sol:16)"),
            "{}",
            access.detail
        );
        assert!(!access.detail.contains("hope"));
        // Nobody writes what the check reads: nothing to decide.
        let mut quiet = vat();
        quiet["nodes"]
            .as_array_mut()
            .expect("nodes")
            .retain(|n| !matches!(s(n, "name"), "rely" | "deny"));
        let q = read_one(vec![quiet], "Vat");
        assert!(q.candidates().iter().all(|c| c.id != "asm.vat.wards"));
    }

    #[test]
    fn a_modifier_is_a_gate_by_what_it_checks_and_found_through_the_bases() {
        let call_stmt = |f: Value| stmt(call(f, vec![], 3));
        let helpers = contract(
            "Base",
            &[],
            vec![
                // `modifier onlyGov() { _onlyGov(); _; }`
                modifier(
                    70,
                    "onlyGov",
                    &[],
                    body(vec![call_stmt(id("_onlyGov", 71))]),
                ),
                func(
                    71,
                    "_onlyGov",
                    "internal",
                    2,
                    json!([]),
                    body(vec![require(bin("==", sender(), id("gov", 72)), 3)]),
                ),
                // Calls code whose source was not found: its name decides.
                modifier(
                    73,
                    "onlyKeeper",
                    &[],
                    body(vec![call_stmt(id("_checkKeeper", 999))]),
                ),
                modifier(
                    74,
                    "whenReady",
                    &[],
                    body(vec![call_stmt(id("_ready", 998))]),
                ),
                // `if (msg.sender == admin) { _; } else { _fallback(); }`
                modifier(
                    76,
                    "ifAdmin",
                    &[],
                    body(vec![json!({ "nodeType": "IfStatement",
                "condition": bin("==", sender(), id("admin", 77)),
                "trueBody": body(vec![json!({ "nodeType": "PlaceholderStatement" })]),
                "falseBody": body(vec![call_stmt(id("_fallback", 997))]) })]),
                ),
            ],
        );
        let wards = contract(
            "Wards",
            &[],
            vec![modifier(
                75,
                "auth",
                &[],
                body(vec![require(
                    bin("==", index(id("wards", 76), sender()), lit("1")),
                    4,
                )]),
            )],
        );
        let live = contract(
            "Live",
            &[],
            vec![modifier(
                77,
                "auth",
                &[],
                body(vec![require(bin("==", id("live", 78), lit("1")), 5)]),
            )],
        );
        let gates = |base: &str, mods: Value| {
            let g = contract(
                "G",
                &[base],
                vec![func(1, "f", "external", 1, mods, body(vec![]))],
            );
            read_one(vec![helpers.clone(), wards.clone(), live.clone(), g], "G").functions[0]
                .gates
                .clone()
        };
        assert_eq!(gates("Base", json!([uses("onlyGov", 70)])), vec!["onlyGov"]);
        assert_eq!(
            gates("Base", json!([uses("onlyKeeper", 73)])),
            vec!["onlyKeeper"]
        );
        assert_eq!(
            gates("Base", json!([uses("whenReady", 74)])),
            Vec::<String>::new()
        );
        assert_eq!(gates("Base", json!([uses("ifAdmin", 76)])), vec!["ifAdmin"]);
        // Two contracts of one file, each with its own `auth`.
        assert_eq!(gates("Wards", json!([uses("auth", 75)])), vec!["auth"]);
        assert_eq!(
            gates("Live", json!([uses("auth", 75)])),
            Vec::<String>::new()
        );
    }

    #[test]
    fn records_calls_with_options_and_lists_fallback_and_receive() {
        let member = |m: &str, on: &str| {
            json!({ "nodeType": "MemberAccess", "memberName": m,
                    "expression": { "nodeType": "Identifier", "name": "t", "typeDescriptions": { "typeString": on } } })
        };
        let options = |e: Value| json!({ "nodeType": "FunctionCallOptions", "expression": e });
        // Before solc 0.6.2: `t.call.value(v)(data)`.
        let old = json!({ "nodeType": "FunctionCall", "expression":
            { "nodeType": "MemberAccess", "memberName": "value", "expression": member("call", "address payable") } });
        let mut fallback = func(
            2,
            "",
            "external",
            2,
            json!([]),
            body(vec![call(old, vec![], 3)]),
        );
        fallback["kind"] = json!("fallback");
        let mut receive = func(4, "", "external", 4, json!([]), body(vec![]));
        receive["kind"] = json!("receive");
        receive["stateMutability"] = json!("payable");
        // solc 0.4: no `kind`.
        let mut ctor = func(6, "C", "public", 6, json!([]), body(vec![]));
        ctor.as_object_mut().expect("object").remove("kind");
        ctor["isConstructor"] = json!(true);
        let mut old_fallback = func(7, "", "public", 7, json!([]), body(vec![]));
        old_fallback.as_object_mut().expect("object").remove("kind");
        // `SafeERC20.safeTransfer(token, ...)` is a call to the token.
        let lib_call = call(
            json!({ "nodeType": "MemberAccess", "memberName": "safeTransfer",
                    "expression": { "nodeType": "Identifier", "name": "SafeERC20",
                                    "typeDescriptions": { "typeString": "type(library SafeERC20)" } } }),
            vec![
                json!({ "nodeType": "Identifier", "name": "token", "typeDescriptions": { "typeString": "contract IERC20" } }),
            ],
            10,
        );
        let cs = read(
            &[file(
                "src/vat.sol",
                vec![
                    contract(
                        "C",
                        &[],
                        vec![
                            func(
                                1,
                                "sweep",
                                "external",
                                1,
                                json!([]),
                                body(vec![
                                    call(options(member("call", "address")), vec![], 8),
                                    call(options(member("price", "contract IOracle")), vec![], 9),
                                    lib_call,
                                ]),
                            ),
                            fallback,
                            receive,
                            ctor,
                        ],
                    ),
                    contract("D", &[], vec![old_fallback]),
                ],
            )],
            &project,
        );
        let c = named(&cs, "C");
        assert_eq!(
            c.calls.get("IOracle.price").map(String::as_str),
            Some("src/vat.sol:9")
        );
        assert_eq!(
            c.calls.get("IERC20.safeTransfer").map(String::as_str),
            Some("src/vat.sol:10")
        );
        assert_eq!(
            c.low_level,
            vec![
                ("call".to_string(), "src/vat.sol:8".to_string()),
                ("call".to_string(), "src/vat.sol:3".to_string())
            ]
        );
        let names: Vec<&str> = c.functions.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["sweep", "fallback", "receive"]);
        assert_eq!(named(&cs, "D").functions[0].name, "fallback");
    }

    #[test]
    fn linearizes_a_diamond_as_the_compiler_does() {
        let f = |fid: i64, line: usize| func(fid, "f", "external", line, json!([]), body(vec![]));
        let cs = read(
            &[file(
                "src/D.sol",
                vec![
                    contract("A", &[], vec![f(1, 1)]),
                    contract("B", &["A"], vec![f(2, 2)]),
                    contract("C", &["A"], vec![f(3, 3)]),
                    // `contract D is B, C`: C is the more derived.
                    contract("D", &["B", "C"], vec![]),
                ],
            )],
            &project,
        );
        let d = named(&cs, "D");
        assert_eq!(d.lineage, vec!["C", "B", "A"]);
        assert_eq!(
            d.functions.len(),
            1,
            "the most derived override is the one that runs"
        );
        assert_eq!(
            (d.functions[0].contract.as_str(), d.functions[0].line),
            ("C", 3)
        );
        assert!(
            d.report().contains("  src/D.sol:3 f - anyone (from C)"),
            "{}",
            d.report()
        );
        assert_eq!(
            merge(vec![vec![2, 0], vec![1, 0], vec![2, 1]]),
            vec![2, 1, 0]
        );
    }

    #[test]
    fn resolves_bases_through_import_aliases() {
        let open = |fid: i64, name: &str| func(fid, name, "external", 2, json!([]), body(vec![]));
        let units = [
            file(
                "src/T.sol",
                vec![
                    import(
                        "lib/Base.sol",
                        &[("Base", Some("Parent")), ("Deep", None)],
                        "",
                    ),
                    import("lib/Other.sol", &[], "O"),
                    contract("T", &["Parent"], vec![]),
                    contract("U", &["O.Other"], vec![]),
                    contract("V", &["Deep"], vec![]),
                ],
            ),
            file(
                "lib/Base.sol",
                vec![
                    import("lib/Deep.sol", &[], ""),
                    contract("Base", &[], vec![open(1, "fromBase")]),
                ],
            ),
            file(
                "lib/Deep.sol",
                vec![contract("Deep", &[], vec![open(2, "fromDeep")])],
            ),
            file(
                "lib/Other.sol",
                vec![contract("Other", &[], vec![open(3, "fromOther")])],
            ),
        ];
        let cs = read(&units, &project);
        let lin = |n: &str| named(&cs, n).lineage.clone();
        assert_eq!(lin("T"), vec!["Base"]);
        assert_eq!(lin("U"), vec!["Other"]);
        assert_eq!(lin("V"), vec!["Deep"]);
        assert_eq!(cs.len(), 3, "library contracts are no targets");
        let t = named(&cs, "T");
        assert!(t.functions[0].library && t.unresolved.is_empty());
        assert!(
            t.report().ends_with("  from libraries: fromBase"),
            "{}",
            t.report()
        );
        assert_eq!(t.names(), (vec![], vec!["fromBase".to_string()]));
    }

    // OpenZeppelin-like AccessControl and UUPS in library files.
    fn access_control() -> Vec<Unit> {
        let role_of = |refd: i64| id("role", refd);
        let ac = contract(
            "AccessControl",
            &[],
            vec![
                json!({ "nodeType": "VariableDeclaration", "id": 100, "name": "_roles", "src": at(2) }),
                // `modifier onlyRole(bytes32 role) { _checkRole(role); _; }`
                modifier(
                    101,
                    "onlyRole",
                    &[(102, "role", false)],
                    body(vec![stmt(call(
                        id("_checkRole", 103),
                        vec![role_of(102)],
                        3,
                    ))]),
                ),
                // `_checkRole(role, _msgSender())`
                with_params(
                    func(
                        103,
                        "_checkRole",
                        "internal",
                        4,
                        json!([]),
                        body(vec![stmt(call(
                            id("_checkRole", 105),
                            vec![role_of(104), call(id("_msgSender", 990), vec![], 5)],
                            5,
                        ))]),
                    ),
                    &[(104, "role", false)],
                ),
                // `if (!hasRole(role, account)) revert`
                with_params(
                    func(
                        105,
                        "_checkRole",
                        "internal",
                        6,
                        json!([]),
                        body(vec![revert_if(
                            not(call(
                                id("hasRole", 108),
                                vec![role_of(106), id("account", 107)],
                                7,
                            )),
                            7,
                        )]),
                    ),
                    &[(106, "role", false), (107, "account", false)],
                ),
                {
                    let mut has = with_params(
                        func(
                            108,
                            "hasRole",
                            "public",
                            8,
                            json!([]),
                            body(vec![
                                json!({ "nodeType": "Return", "expression": index(index(id("_roles", 100), role_of(109)), id("account", 110)) }),
                            ]),
                        ),
                        &[(109, "role", false), (110, "account", false)],
                    );
                    has["stateMutability"] = json!("view");
                    has
                },
                with_params(
                    func(
                        111,
                        "grantRole",
                        "public",
                        9,
                        json!([uses_with(
                            "onlyRole",
                            vec![call(id("getRoleAdmin", 115), vec![role_of(112)], 9)]
                        )]),
                        body(vec![assign(index(
                            index(id("_roles", 100), role_of(112)),
                            id("account", 113),
                        ))]),
                    ),
                    &[(112, "role", false), (113, "account", false)],
                ),
                // `_mint(account, v)`: a zero-address check is no caller check.
                with_params(
                    func(
                        116,
                        "_mint",
                        "internal",
                        10,
                        json!([]),
                        body(vec![
                            revert_if(bin("==", id("account", 117), address(lit("0"))), 11),
                            assign(index(id("_balances", 118), id("account", 117))),
                        ]),
                    ),
                    &[(117, "account", false)],
                ),
                json!({ "nodeType": "VariableDeclaration", "id": 118, "name": "_balances", "src": at(12) }),
                // Found, so nothing falls back to the modifier's name.
                func(
                    990,
                    "_msgSender",
                    "internal",
                    13,
                    json!([]),
                    body(vec![
                        json!({ "nodeType": "Return", "expression": sender() }),
                    ]),
                ),
            ],
        );
        let up = contract(
            "UUPSUpgradeable",
            &[],
            vec![
                with_params(
                    func(
                        201,
                        "_authorizeUpgrade",
                        "internal",
                        2,
                        json!([]),
                        json!(null),
                    ),
                    &[(202, "x", false)],
                ),
                // `upgradeToAndCall(x) { _authorizeUpgrade(x); ... }`
                with_params(
                    func(
                        203,
                        "upgradeToAndCall",
                        "public",
                        3,
                        json!([]),
                        body(vec![stmt(call(
                            id("_authorizeUpgrade", 201),
                            vec![id("x", 204)],
                            4,
                        ))]),
                    ),
                    &[(204, "x", false)],
                ),
            ],
        );
        let mut authorize = with_params(
            func(
                5,
                "_authorizeUpgrade",
                "internal",
                20,
                json!([uses_with("onlyRole", vec![id("UPGRADER_ROLE", 6)])]),
                body(vec![]),
            ),
            &[(7, "x", false)],
        );
        authorize["overrides"] = json!({});
        let token = contract(
            "Token",
            &["AccessControl", "UUPSUpgradeable"],
            vec![
                func(
                    1,
                    "mint",
                    "external",
                    10,
                    json!([uses_with("onlyRole", vec![id("MINTER_ROLE", 2)])]),
                    body(vec![]),
                ),
                func(
                    3,
                    "claim",
                    "external",
                    12,
                    json!([]),
                    body(vec![stmt(call(id("_mint", 1116), vec![sender()], 13))]),
                ),
                authorize,
            ],
        );
        vec![
            file(
                "src/Token.sol",
                vec![
                    import("lib/AccessControl.sol", &[("AccessControl", None)], ""),
                    import("lib/UUPSUpgradeable.sol", &[("UUPSUpgradeable", None)], ""),
                    token,
                ],
            ),
            file("lib/AccessControl.sol", vec![ac]),
            file("lib/UUPSUpgradeable.sol", vec![up]),
        ]
    }

    #[test]
    fn follows_the_caller_into_parameters_across_files() {
        let cs = read(&access_control(), &project);
        let t = named(&cs, "Token");
        let f = |n: &str| t.functions.iter().find(|f| f.name == n).expect(n);
        assert_eq!(f("mint").gates, vec!["onlyRole(MINTER_ROLE)"]);
        assert_eq!(f("grantRole").gates, vec!["onlyRole(getRoleAdmin(role))"]);
        assert!(f("grantRole").library);
        // `_mint(msg.sender, 1)` only compares the caller with zero.
        assert!(f("claim").gates.is_empty() && f("claim").checks.is_empty());
        let report = t.report();
        assert!(
            report.contains("  from libraries: grantRole - onlyRole(getRoleAdmin(role)), upgradeToAndCall - checks the caller\n"),
            "{report}"
        );
        let cands = t.candidates();
        let roles = cands
            .iter()
            .find(|c| c.id == "asm.token.roles")
            .expect("roles");
        assert_eq!(
            roles.title,
            "Token: grantRole decides who passes onlyRole (_roles)"
        );
        assert!(cands.iter().all(|c| c.id != "asm.token.role-admin"));
        let books = cands
            .iter()
            .find(|c| c.id == "inv.token.books")
            .expect("books");
        assert!(books.detail.contains(": claim."), "{}", books.detail);
    }

    #[test]
    fn dispatches_an_inherited_call_to_the_most_derived_override() {
        let cs = read(&access_control(), &project);
        let t = named(&cs, "Token");
        let up = t
            .functions
            .iter()
            .find(|f| f.name == "upgradeToAndCall")
            .expect("upgrade");
        assert_eq!(
            (up.file.as_str(), up.checks.clone()),
            ("lib/UUPSUpgradeable.sol", vec![4])
        );
        assert_eq!(
            t.upgrade_gate,
            Some(("onlyRole(UPGRADER_ROLE)".into(), "src/Token.sol:20".into()))
        );
    }

    #[test]
    fn finds_state_written_through_inherited_code_and_storage_parameters() {
        let members = || id("members", 1);
        let attached = json!({ "nodeType": "MemberAccess", "memberName": "add", "expression": members(),
            "typeDescriptions": { "typeIdentifier": "t_function_internal_nonpayable$_t_struct$_Set_$1_storage_ptr_$_t_address_$returns$__$attached_to$_t_struct$_Set" } });
        let base = contract(
            "Base",
            &[],
            vec![
                json!({ "nodeType": "UsingForDirective", "libraryName": { "name": "Lib" } }),
                json!({ "nodeType": "VariableDeclaration", "id": 1, "name": "members", "src": at(2) }),
                json!({ "nodeType": "VariableDeclaration", "id": 2, "name": "count", "src": at(3) }),
                func(
                    3,
                    "join",
                    "external",
                    4,
                    json!([]),
                    body(vec![stmt(call(attached, vec![sender()], 5))]),
                ),
                func(
                    4,
                    "_bump",
                    "internal",
                    6,
                    json!([]),
                    body(vec![
                        json!({ "nodeType": "UnaryOperation", "operator": "++", "subExpression": id("count", 2) }),
                    ]),
                ),
            ],
        );
        let lib = json!({ "nodeType": "ContractDefinition", "name": "Lib", "contractKind": "library", "nodes": [
            with_params(func(10, "add", "internal", 2, json!([]), body(vec![stmt(call(
                json!({ "nodeType": "MemberAccess", "memberName": "push",
                        "expression": { "nodeType": "MemberAccess", "memberName": "values", "expression": id("set", 11) } }),
                vec![id("v", 12)], 3))])),
                &[(11, "set", true), (12, "v", false)]),
        ] });
        let t = contract(
            "T",
            &["Base"],
            vec![func(
                1,
                "poke",
                "external",
                8,
                json!([]),
                body(vec![stmt(call(id("_bump", 4), vec![], 9))]),
            )],
        );
        let cs = read(
            &[
                file("src/T.sol", vec![import("src/Base.sol", &[], ""), t]),
                file("src/Base.sol", vec![import("lib/Lib.sol", &[], ""), base]),
                file("lib/Lib.sol", vec![lib]),
            ],
            &project,
        );
        let t = named(&cs, "T");
        let var = |n: &str| t.state.iter().find(|v| v.name == n).expect(n);
        assert_eq!(var("members").writers, vec!["join"]);
        assert_eq!(var("count").writers, vec!["poke"]);
        let report = t.report();
        assert!(
            report.contains("  src/Base.sol:4 join - anyone (from Base)\n"),
            "{report}"
        );
        assert!(
            report.contains("  src/Base.sol:2 state members - written by join (from Base)"),
            "{report}"
        );
        assert_eq!(t.names().0, vec!["poke", "join"]);
    }

    #[test]
    fn reads_namespaced_storage_and_flags_assembly_writes() {
        let getter = json!({ "nodeType": "FunctionCall", "expression": id("_getStorage", 3),
            "typeDescriptions": { "typeString": "struct S storage pointer" } });
        let field = |m: &str| json!({ "nodeType": "MemberAccess", "memberName": m, "expression": getter.clone() });
        let sstore = json!({ "nodeType": "InlineAssembly", "src": at(9), "AST": { "nodeType": "YulBlock",
            "statements": [{ "nodeType": "YulFunctionCall", "functionName": { "name": "sstore" } },
                           { "nodeType": "YulFunctionCall", "functionName": { "name": "delegatecall" } }] } });
        let c = contract(
            "W",
            &[],
            vec![
                modifier(
                    1,
                    "onlyOwner",
                    &[],
                    body(vec![require(index(field("isOwner"), sender()), 2)]),
                ),
                func(3, "_getStorage", "internal", 3, json!([]), body(vec![])),
                func(
                    4,
                    "addOwner",
                    "external",
                    4,
                    json!([uses("onlyOwner", 1)]),
                    body(vec![assign(index(field("isOwner"), id("o", 5)))]),
                ),
                func(
                    6,
                    "upgrade",
                    "external",
                    8,
                    json!([uses("onlyOwner", 1)]),
                    body(vec![sstore]),
                ),
            ],
        );
        let s_struct = json!({ "nodeType": "StructDefinition", "name": "S", "members": [
            { "nodeType": "VariableDeclaration", "name": "isOwner", "src": at(1) }] });
        let cs = read(&[file("src/W.sol", vec![s_struct, c])], &project);
        let w = &cs[0];
        assert_eq!(w.state[0].name, "S.isOwner");
        assert_eq!(w.state[0].writers, vec!["addOwner"]);
        let report = w.report();
        assert!(
            report.contains("src/W.sol:8 upgrade - onlyOwner, writes storage in assembly\n"),
            "{report}"
        );
        assert!(
            report.contains("src/W.sol:9 low-level delegatecall (assembly)"),
            "{report}"
        );
        let ids: Vec<String> = w.candidates().into_iter().map(|c| c.id).collect();
        assert!(ids.contains(&"asm.w.isowner".to_string()), "{ids:?}");
        assert!(
            ids.contains(&"asm.w.low-level-delegatecall-assembly".to_string()),
            "{ids:?}"
        );
    }

    // A call into another contract, typed as the compiler types it.
    fn ext(target: Value, member: &str, mutability: &str) -> Value {
        json!({ "nodeType": "MemberAccess", "memberName": member, "expression": target,
                "typeDescriptions": { "typeIdentifier":
                    format!("t_function_external_{mutability}$_t_address_$returns$_t_bool_$") } })
    }
    fn placeholder() -> Value {
        json!({ "nodeType": "PlaceholderStatement" })
    }

    #[test]
    fn the_caller_handed_to_another_contract_is_a_check_only_when_it_is_asked_about() {
        let gem = || id("gem", 1);
        let c = read_one(
            vec![contract(
                "Join",
                &[],
                vec![
                    json!({ "nodeType": "VariableDeclaration", "id": 1, "name": "gem", "src": at(2) }),
                    // `require(gem.transferFrom(msg.sender, ...))` asks the token to act.
                    func(
                        10,
                        "join",
                        "external",
                        3,
                        json!([]),
                        body(vec![require(
                            call(
                                ext(gem(), "transferFrom", "nonpayable"),
                                vec![sender(), lit("1")],
                                4,
                            ),
                            4,
                        )]),
                    ),
                    func(
                        11,
                        "exit",
                        "external",
                        5,
                        json!([]),
                        body(vec![
                            local(
                                80,
                                "bool",
                                call(
                                    ext(gem(), "transfer", "nonpayable"),
                                    vec![sender(), lit("1")],
                                    6,
                                ),
                            ),
                            require(id("ok", 80), 7),
                        ]),
                    ),
                    // `if (!token.hasRole(R, msg.sender)) revert`: a question about the caller.
                    modifier(
                        20,
                        "onlyExternalAdmin",
                        &[],
                        body(vec![
                            revert_if(
                                not(call(
                                    ext(gem(), "hasRole", "view"),
                                    vec![id("R", 2), sender()],
                                    9,
                                )),
                                9,
                            ),
                            placeholder(),
                        ]),
                    ),
                    func(
                        12,
                        "register",
                        "external",
                        10,
                        json!([uses("onlyExternalAdmin", 20)]),
                        body(vec![]),
                    ),
                    // Celo: only the VM, which calls from the zero address.
                    modifier(
                        21,
                        "onlyCeloVm",
                        &[],
                        body(vec![
                            require(bin("==", sender(), address(lit("0"))), 12),
                            placeholder(),
                        ]),
                    ),
                    func(
                        13,
                        "debit",
                        "external",
                        13,
                        json!([uses("onlyCeloVm", 21)]),
                        body(vec![]),
                    ),
                    func(
                        14,
                        "credit",
                        "external",
                        14,
                        json!([]),
                        body(vec![revert_if(
                            bin("!=", address(sender()), address(lit("0"))),
                            15,
                        )]),
                    ),
                    // Anyone but the zero address is no restriction.
                    func(
                        16,
                        "open",
                        "external",
                        16,
                        json!([]),
                        body(vec![require(bin("!=", sender(), address(lit("0"))), 17)]),
                    ),
                ],
            )],
            "Join",
        );
        let f = |n: &str| c.functions.iter().find(|f| f.name == n).expect(n);
        assert!(f("join").checks.is_empty(), "{:?}", f("join").checks);
        assert!(f("exit").checks.is_empty(), "{:?}", f("exit").checks);
        assert_eq!(f("register").gates, vec!["onlyExternalAdmin"]);
        assert_eq!(f("debit").gates, vec!["onlyCeloVm"]);
        assert_eq!(f("credit").checks, vec![15]);
        assert!(f("open").checks.is_empty());
        assert!(
            c.report().contains("src/vat.sol:3 join - anyone\n"),
            "{}",
            c.report()
        );
    }

    #[test]
    fn an_initializer_guarded_by_its_own_code_is_known_by_its_name() {
        let c = read_one(
            vec![contract(
                "Wallet",
                &[],
                vec![
                    json!({ "nodeType": "VariableDeclaration", "id": 1, "name": "initialized", "src": at(2) }),
                    func(
                        10,
                        "initialize",
                        "external",
                        3,
                        json!([]),
                        body(vec![
                            require(not(id("initialized", 1)), 4),
                            assign(id("initialized", 1)),
                        ]),
                    ),
                    with_params(
                        func(11, "initialize", "external", 5, json!([]), body(vec![])),
                        &[(90, "x", false)],
                    ),
                    func(12, "initializeV2", "external", 6, json!([]), body(vec![])),
                    func(13, "initiate", "external", 7, json!([]), body(vec![])),
                    func(
                        14,
                        "init",
                        "external",
                        8,
                        json!([]),
                        body(vec![require(bin("==", sender(), id("owner", 2)), 9)]),
                    ),
                    func(
                        15,
                        "setUp",
                        "external",
                        10,
                        json!([uses_with("reinitializer", vec![lit("2")])]),
                        body(vec![]),
                    ),
                ],
            )],
            "Wallet",
        );
        let cands = c.candidates();
        let by_id = |i: &str| cands.iter().find(|c| c.id == i);
        let init = by_id("asm.wallet.initialize").expect("initialize");
        assert_eq!(
            init.title,
            "Wallet: initialize was called by the deployer before anyone else could"
        );
        assert_eq!(init.evidence, vec!["src/vat.sol:3", "src/vat.sol:5"]);
        assert!(
            init.detail.contains("no initializer modifier"),
            "{}",
            init.detail
        );
        assert!(by_id("asm.wallet.initializev2").is_some());
        assert!(by_id("asm.wallet.initiate").is_none());
        assert!(by_id("asm.wallet.init").is_none(), "it checks the caller");
        let set_up = by_id("asm.wallet.setup").expect("reinitializer");
        assert!(set_up.detail.contains("runs once"), "{}", set_up.detail);
        let ids: Vec<&str> = cands.iter().map(|c| c.id.as_str()).collect();
        let unique: BTreeSet<&str> = ids.iter().copied().collect();
        assert_eq!(unique.len(), ids.len(), "{ids:?}");
    }

    #[test]
    fn a_base_that_is_reported_alone_says_who_inherits_it_and_ids_stay_unique() {
        let gated = |fid: i64, line: usize| {
            func(
                fid,
                "set",
                "external",
                line,
                json!([uses_with("onlyOwner", vec![])]),
                body(vec![]),
            )
        };
        let cs = read(
            &[
                file(
                    "src/Base.sol",
                    vec![contract("Base", &[], vec![gated(1, 2)])],
                ),
                file(
                    "src/a/Token.sol",
                    vec![
                        import("src/Base.sol", &[], ""),
                        contract(
                            "Token",
                            &["Base"],
                            vec![func(2, "mint", "external", 3, json!([]), body(vec![]))],
                        ),
                    ],
                ),
                file(
                    "src/b/Token.sol",
                    vec![contract("Token", &[], vec![gated(3, 4)])],
                ),
            ],
            &project,
        );
        assert_eq!(cs.len(), 3);
        let base = named(&cs, "Base");
        assert_eq!(base.inherited_by, vec!["Token"]);
        assert!(
            base.report()
                .contains("  inherited by: Token (its code is reported there too)\n"),
            "{}",
            base.report()
        );
        assert_eq!(base.key, "base");
        let ids: Vec<String> = cs
            .iter()
            .flat_map(Contract::candidates)
            .map(|c| c.id)
            .collect();
        assert!(
            ids.contains(&"asm.token-src-a-token.onlyowner".to_string()),
            "{ids:?}"
        );
        assert!(
            ids.contains(&"asm.token-src-b-token.onlyowner".to_string()),
            "{ids:?}"
        );
        let unique: BTreeSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "{ids:?}");
    }

    #[test]
    fn reads_what_library_code_calls_and_flags_library_assembly_writes() {
        let sstore = json!({ "nodeType": "InlineAssembly", "src": at(3), "AST": { "nodeType": "YulBlock",
            "statements": [{ "nodeType": "YulFunctionCall", "functionName": { "name": "sstore" } }] } });
        let up = contract(
            "Up",
            &[],
            vec![func(
                1,
                "upgradeToAndCall",
                "external",
                2,
                json!([]),
                body(vec![sstore]),
            )],
        );
        let staticcall = json!({ "nodeType": "MemberAccess", "memberName": "staticcall",
            "expression": { "nodeType": "Identifier", "name": "signer", "referencedDeclaration": 21,
                            "typeDescriptions": { "typeString": "address" } } });
        let sig = json!({ "nodeType": "ContractDefinition", "name": "Sig", "contractKind": "library", "nodes": [
            with_params(func(20, "check", "internal", 2, json!([]), body(vec![stmt(call(staticcall, vec![lit("0")], 3))])),
                        &[(21, "signer", false)]),
        ] });
        let check = json!({ "nodeType": "MemberAccess", "memberName": "check",
            "expression": { "nodeType": "Identifier", "name": "Sig",
                            "typeDescriptions": { "typeString": "type(library Sig)" } } });
        let w = contract(
            "W",
            &["Up"],
            vec![func(
                2,
                "verify",
                "external",
                4,
                json!([]),
                body(vec![stmt(call(check, vec![id("who", 9)], 5))]),
            )],
        );
        let cs = read(
            &[
                file(
                    "src/W.sol",
                    vec![
                        import("lib/Up.sol", &[], ""),
                        import("lib/Sig.sol", &[], ""),
                        w,
                    ],
                ),
                file("lib/Up.sol", vec![up]),
                file("lib/Sig.sol", vec![sig]),
            ],
            &project,
        );
        let report = named(&cs, "W").report();
        assert!(
            report.contains(
                "  from libraries: upgradeToAndCall - anyone, writes storage in assembly\n"
            ),
            "{report}"
        );
        assert!(
            report.contains("  lib/Sig.sol:3 low-level staticcall"),
            "{report}"
        );
    }

    // `on.member` with `on` typed as the compiler types it.
    fn member_of(on: &str, ty: &str, member: &str) -> Value {
        json!({ "nodeType": "MemberAccess", "memberName": member,
                "expression": { "nodeType": "Identifier", "name": on, "typeDescriptions": { "typeString": ty } } })
    }
    fn yul(builtin: &str, line: usize) -> Value {
        json!({ "nodeType": "InlineAssembly", "src": at(line), "AST": { "nodeType": "YulBlock",
            "statements": [{ "nodeType": "YulFunctionCall", "functionName": { "name": builtin } }] } })
    }

    #[test]
    fn reports_selfdestruct_with_the_entry_points_that_reach_it() {
        let wards = |key: Value| index(id("wards", 1), key);
        let kill = call(id("selfdestruct", -21), vec![address(sender())], 5);
        let old = call(id("suicide", -21), vec![sender()], 9);
        // A function of the project that happens to share the name is no builtin.
        let own = call(id("selfdestruct", 30), vec![], 11);
        let c = contract(
            "Vat",
            &[],
            vec![
                json!({ "nodeType": "VariableDeclaration", "id": 1, "name": "wards", "src": at(1) }),
                modifier(
                    2,
                    "auth",
                    &[],
                    body(vec![
                        require(bin("==", wards(sender()), lit("1")), 2),
                        placeholder(),
                    ]),
                ),
                func(3, "_end", "internal", 4, json!([]), body(vec![stmt(kill)])),
                func(
                    4,
                    "cage",
                    "external",
                    6,
                    json!([uses("auth", 2)]),
                    body(vec![stmt(call(id("_end", 3), vec![], 7))]),
                ),
                func(
                    5,
                    "wipe",
                    "external",
                    8,
                    json!([]),
                    body(vec![stmt(old), yul("selfdestruct", 10)]),
                ),
                func(6, "move", "external", 12, json!([]), body(vec![stmt(own)])),
            ],
        );
        let vat = read_one(vec![c], "Vat");
        let report = vat.report();
        for line in [
            "  src/vat.sol:5 selfdestruct",
            "  src/vat.sol:9 selfdestruct",
            "  src/vat.sol:10 selfdestruct (assembly)",
        ] {
            assert!(report.contains(line), "{report}");
        }
        assert!(!report.contains("src/vat.sol:11 selfdestruct"), "{report}");
        let reach: Vec<(&str, bool)> = vat
            .functions
            .iter()
            .map(|f| (f.name.as_str(), f.selfdestruct))
            .collect();
        assert_eq!(reach, vec![("cage", true), ("wipe", true), ("move", false)]);
        let cand = vat
            .candidates()
            .into_iter()
            .find(|c| c.id == "asm.vat.selfdestruct")
            .expect("selfdestruct");
        assert_eq!(
            cand.title,
            "Vat: whoever reaches selfdestruct can remove its code (or, after Cancun, send away its ether)"
        );
        assert!(
            cand.detail
                .contains("Entry points that reach it: cage (auth); wipe (anyone)."),
            "{}",
            cand.detail
        );
        assert_eq!(
            cand.evidence,
            vec!["src/vat.sol:5", "src/vat.sol:9", "src/vat.sol:10"]
        );
    }

    #[test]
    fn reports_ether_sent_once_and_tells_it_from_a_token_transfer() {
        let options = |e: Value, name: &str, v: Value| json!({ "nodeType": "FunctionCallOptions", "expression": e, "names": [name], "options": [v] });
        // `addr.transfer(x)` from a library attached to `address` is no builtin.
        let mut attached = member_of("to", "address", "transfer");
        attached["typeDescriptions"] = json!({ "typeIdentifier":
            "t_function_internal_nonpayable$_t_address_$_t_uint256_$returns$__$attached_to$_t_address_$" });
        // Before solc 0.6.2: `to.call.value(v)(data)`.
        let old = json!({ "nodeType": "FunctionCall", "arguments": [id("wad", 9)],
            "expression": { "nodeType": "MemberAccess", "memberName": "value",
                            "expression": member_of("to", "address", "call") } });
        // `functionCall` passes zero for the value; `sendValue` passes an amount.
        let target = || {
            json!({ "nodeType": "Identifier", "name": "target", "referencedDeclaration": 41,
                                "typeDescriptions": { "typeString": "address" } })
        };
        let with_value = call(
            options(
                json!({ "nodeType": "MemberAccess", "memberName": "call", "expression": target() }),
                "value",
                id("value", 42),
            ),
            vec![],
            3,
        );
        let address_lib = json!({ "nodeType": "ContractDefinition", "name": "Address", "contractKind": "library", "nodes": [
            with_params(func(40, "functionCallWithValue", "internal", 2, json!([]), body(vec![stmt(with_value)])),
                        &[(41, "target", false), (42, "value", false)]),
            with_params(func(43, "functionCall", "internal", 4, json!([]),
                             body(vec![stmt(call(id("functionCallWithValue", 40), vec![id("target", 44), id("zero", 45)], 5))])),
                        &[(44, "target", false), (45, "zero", false)]),
            with_params(func(46, "functionCallZero", "internal", 6, json!([]),
                             body(vec![stmt(call(id("functionCall", 43), vec![id("target", 47), lit("0")], 7))])),
                        &[(47, "target", false)]),
        ] });
        let lib = |f: &str| member_of("Address", "type(library Address)", f);
        let c = contract(
            "Pay",
            &[],
            vec![func(
                1,
                "pay",
                "external",
                10,
                json!([]),
                body(vec![
                    stmt(call(
                        member_of("to", "address payable", "transfer"),
                        vec![id("wad", 9)],
                        11,
                    )),
                    stmt(call(
                        member_of("to", "address payable", "send"),
                        vec![id("wad", 9)],
                        12,
                    )),
                    stmt(call(
                        member_of("token", "contract IERC20", "transfer"),
                        vec![id("to", 8), id("wad", 9)],
                        13,
                    )),
                    stmt(call(
                        options(member_of("to", "address", "call"), "value", id("wad", 9)),
                        vec![],
                        14,
                    )),
                    stmt(call(
                        options(member_of("to", "address", "call"), "value", lit("0")),
                        vec![],
                        15,
                    )),
                    stmt(call(
                        options(member_of("to", "address", "call"), "gas", id("wad", 9)),
                        vec![],
                        16,
                    )),
                    stmt(call(old, vec![], 17)),
                    stmt(call(attached, vec![id("wad", 9)], 18)),
                    stmt(call(lib("functionCallZero"), vec![id("to", 8)], 19)),
                ]),
            )],
        );
        let cs = read(
            &[
                file("src/Pay.sol", vec![import("lib/Address.sol", &[], ""), c]),
                file("lib/Address.sol", vec![address_lib]),
            ],
            &project,
        );
        let pay = named(&cs, "Pay");
        let pairs = |v: &[(&str, &str)]| -> Vec<(String, String)> {
            v.iter()
                .map(|(a, b)| ((*a).to_string(), (*b).to_string()))
                .collect()
        };
        assert_eq!(
            pay.sends,
            pairs(&[
                ("transfer", "src/Pay.sol:11"),
                ("send", "src/Pay.sol:12"),
                ("call", "src/Pay.sol:14"),
                ("call", "src/Pay.sol:17"),
            ])
        );
        assert_eq!(
            pay.low_level,
            pairs(&[
                ("call", "src/Pay.sol:15"),
                ("call", "src/Pay.sol:16"),
                ("call", "lib/Address.sol:3"),
            ])
        );
        assert_eq!(
            pay.calls.keys().collect::<Vec<_>>(),
            vec!["IERC20.transfer"]
        );
        let report = pay.report();
        assert!(
            report.contains("  src/Pay.sol:11 sends ether (transfer)\n"),
            "{report}"
        );
        assert!(
            report.contains("  src/Pay.sol:14 sends ether (call)\n"),
            "{report}"
        );
        assert!(!report.contains("src/Pay.sol:14 low-level"), "{report}");
        let cands = pay.candidates();
        let ether = cands
            .iter()
            .find(|c| c.id == "asm.pay.sends-ether")
            .expect("sends ether");
        assert_eq!(
            ether.title,
            "Pay: the addresses it sends ether to can receive it (and cannot reenter harmfully)"
        );
        assert!(
            ether.detail.contains("with transfer, send, call."),
            "{}",
            ether.detail
        );
        assert_eq!(
            ether.evidence,
            vec![
                "src/Pay.sol:11",
                "src/Pay.sol:12",
                "src/Pay.sol:14",
                "src/Pay.sol:17"
            ]
        );
    }

    #[test]
    fn a_library_value_that_is_not_always_zero_sends_ether() {
        let target = json!({ "nodeType": "Identifier", "name": "target", "referencedDeclaration": 41,
                             "typeDescriptions": { "typeString": "address" } });
        let with_value = call(
            json!({ "nodeType": "FunctionCallOptions", "names": ["value"], "options": [id("value", 42)],
                    "expression": { "nodeType": "MemberAccess", "memberName": "call", "expression": target } }),
            vec![],
            3,
        );
        let address_lib = json!({ "nodeType": "ContractDefinition", "name": "Address", "contractKind": "library", "nodes": [
            with_params(func(40, "sendValue", "internal", 2, json!([]), body(vec![stmt(with_value)])),
                        &[(41, "target", false), (42, "value", false)]),
        ] });
        let lib = member_of("Address", "type(library Address)", "sendValue");
        let c = contract(
            "Pay",
            &[],
            vec![func(
                1,
                "pay",
                "external",
                10,
                json!([]),
                body(vec![
                    stmt(call(lib.clone(), vec![id("to", 8), lit("0")], 11)),
                    stmt(call(lib, vec![id("to", 8), id("wad", 9)], 12)),
                ]),
            )],
        );
        let cs = read(
            &[
                file("src/Pay.sol", vec![import("lib/Address.sol", &[], ""), c]),
                file("lib/Address.sol", vec![address_lib]),
            ],
            &project,
        );
        let pay = named(&cs, "Pay");
        assert_eq!(
            pay.sends,
            vec![("call".to_string(), "lib/Address.sol:3".to_string())]
        );
        assert!(pay.low_level.is_empty(), "{:?}", pay.low_level);
    }

    // `StorageSlot.getAddressSlot(slot)`, typed as solc types it.
    fn slot_call(lib: &str, getter: &str, slot: Value, line: usize) -> Value {
        let mut c = call(
            member_of(lib, &format!("type(library {lib})"), getter),
            vec![slot],
            line,
        );
        c["typeDescriptions"] =
            json!({ "typeString": "struct StorageSlot.AddressSlot storage pointer" });
        c
    }
    fn slot_value(c: Value) -> Value {
        json!({ "nodeType": "MemberAccess", "memberName": "value", "src": c["src"], "expression": c })
    }

    #[test]
    fn ties_storage_slot_writes_to_the_slot_constant_and_its_writers() {
        let constant = |cid: i64, name: &str, line: usize| {
            json!({ "nodeType": "VariableDeclaration", "id": cid, "name": name, "constant": true,
                    "stateVariable": true, "src": at(line) })
        };
        let set = |cid: i64, name: &str, line: usize| {
            stmt(
                json!({ "nodeType": "Assignment", "operator": "=", "rightHandSide": id("x", 99),
                "leftHandSide": slot_value(slot_call("StorageSlot", "getAddressSlot", id(name, cid), line)) }),
            )
        };
        let utils = json!({ "nodeType": "ContractDefinition", "name": "ERC1967Utils", "contractKind": "library", "nodes": [
            constant(50, "IMPLEMENTATION_SLOT", 1),
            constant(51, "ADMIN_SLOT", 2),
            func(52, "_setImplementation", "private", 3, json!([]), body(vec![set(50, "IMPLEMENTATION_SLOT", 4)])),
            func(53, "upgradeToAndCall", "internal", 5, json!([]), body(vec![stmt(call(id("_setImplementation", 52), vec![], 6))])),
            func(54, "getAdmin", "internal", 7, json!([]),
                 body(vec![ret(slot_value(slot_call("StorageSlot", "getAddressSlot", id("ADMIN_SLOT", 51), 8)))])),
            func(55, "changeAdmin", "internal", 9, json!([]), body(vec![set(51, "ADMIN_SLOT", 10)])),
        ] });
        let lib = |f: &str| member_of("ERC1967Utils", "type(library ERC1967Utils)", f);
        // `using StorageSlot for bytes32; FLAG.getBooleanSlot().value = true`.
        let mut bound = call(
            json!({ "nodeType": "MemberAccess", "memberName": "getBooleanSlot", "expression":
                { "nodeType": "Identifier", "name": "FLAG", "referencedDeclaration": 2,
                  "typeDescriptions": { "typeString": "bytes32" } } }),
            vec![],
            15,
        );
        bound["typeDescriptions"] =
            json!({ "typeString": "struct StorageSlot.BooleanSlot storage pointer" });
        let keccak = call(id("keccak256", -8), vec![lit("1")], 17);
        let p = contract(
            "P",
            &[],
            vec![
                constant(2, "FLAG", 1),
                modifier(
                    3,
                    "onlyAdmin",
                    &[],
                    body(vec![
                        require(bin("==", sender(), call(lib("getAdmin"), vec![], 2)), 2),
                        placeholder(),
                    ]),
                ),
                {
                    let mut ctor = func(
                        4,
                        "",
                        "public",
                        3,
                        json!([]),
                        body(vec![stmt(call(lib("changeAdmin"), vec![], 4))]),
                    );
                    ctor["kind"] = json!("constructor");
                    ctor
                },
                func(
                    5,
                    "upgradeTo",
                    "external",
                    5,
                    json!([uses("onlyAdmin", 3)]),
                    body(vec![stmt(call(lib("upgradeToAndCall"), vec![], 6))]),
                ),
                // The constant through the library's name, from another file.
                func(
                    6,
                    "setAdmin",
                    "external",
                    7,
                    json!([uses("onlyAdmin", 3)]),
                    body(vec![stmt(json!({
                    "nodeType": "Assignment", "operator": "=", "rightHandSide": id("x", 99),
                    "leftHandSide": slot_value(slot_call("StorageSlot", "getAddressSlot",
                        member_of("ERC1967Utils", "type(library ERC1967Utils)", "ADMIN_SLOT"), 8)) }))]),
                ),
                func(
                    7,
                    "flag",
                    "external",
                    14,
                    json!([]),
                    body(vec![stmt(json!({
                    "nodeType": "Assignment", "operator": "=", "rightHandSide": lit("true"),
                    "leftHandSide": slot_value(bound) }))]),
                ),
                func(
                    8,
                    "mark",
                    "external",
                    16,
                    json!([]),
                    body(vec![stmt(json!({
                    "nodeType": "Assignment", "operator": "=", "rightHandSide": id("x", 99),
                    "leftHandSide": slot_value(slot_call("StorageSlot", "getAddressSlot", keccak, 17)) }))]),
                ),
            ],
        );
        let cs = read(
            &[
                file(
                    "src/P.sol",
                    vec![import("lib/ERC1967Utils.sol", &[], ""), p],
                ),
                file("lib/ERC1967Utils.sol", vec![utils]),
            ],
            &project,
        );
        let p = named(&cs, "P");
        let report = p.report();
        for line in [
            "  src/P.sol:1 state FLAG - constant\n",
            "  lib/ERC1967Utils.sol:1 state slot IMPLEMENTATION_SLOT - written by upgradeTo (from ERC1967Utils)\n",
            "  lib/ERC1967Utils.sol:2 state slot ADMIN_SLOT - written by setAdmin, set at deployment (from ERC1967Utils)\n",
            "  src/P.sol:1 state slot FLAG - written by flag\n",
            "  src/P.sol:17 state an unnamed slot - written by mark\n",
        ] {
            assert!(format!("{report}\n").contains(line), "{line}\n{report}");
        }
        // Who passes the gate is decided by who writes the slot it reads.
        assert_eq!(p.guards.len(), 1);
        assert_eq!(p.guards[0].vars, vec!["ADMIN_SLOT"]);
        assert_eq!(p.guards[0].writers, vec!["setAdmin"]);
    }

    #[test]
    fn state_set_by_an_upgradeable_contracts_constructor_is_not_the_proxys() {
        let var = |vid: i64, name: &str, line: usize, extra: Value| {
            let mut v = json!({ "nodeType": "VariableDeclaration", "stateVariable": true,
                                "id": vid, "name": name, "src": at(line) });
            for (k, x) in extra.as_object().into_iter().flatten() {
                v[k] = x.clone();
            }
            v
        };
        let nodes = |name: &str| {
            let mut ctor = func(
                10,
                "",
                "public",
                6,
                json!([]),
                body(vec![
                    stmt(assign(id("owner", 1))),
                    stmt(assign(id("limit", 2))),
                    stmt(assign(id("token", 3))),
                ]),
            );
            ctor["kind"] = json!("constructor");
            contract(
                name,
                &["Initializable"],
                vec![
                    var(1, "owner", 1, json!({})),
                    var(2, "limit", 2, json!({})),
                    var(3, "token", 3, json!({ "mutability": "immutable" })),
                    var(4, "ROLE", 4, json!({ "constant": true, "value": lit("1") })),
                    var(5, "fee", 5, json!({ "value": lit("5") })),
                    ctor,
                    func(
                        11,
                        "setLimit",
                        "external",
                        7,
                        json!([]),
                        body(vec![stmt(assign(id("limit", 2)))]),
                    ),
                ],
            )
        };
        let report = read_one(vec![nodes("Impl")], "Impl").report();
        let behind = "set in the implementation's constructor (not in the proxy's storage)";
        for line in [
            format!("  src/vat.sol:1 state owner - {behind}, never after\n"),
            format!("  src/vat.sol:2 state limit - written by setLimit, {behind}\n"),
            "  src/vat.sol:3 state token - immutable\n".to_string(),
            "  src/vat.sol:4 state ROLE - constant\n".to_string(),
            format!("  src/vat.sol:5 state fee - {behind}, never after\n"),
        ] {
            assert!(format!("{report}\n").contains(&line), "{line}\n{report}");
        }
        // Without an upgradeable base or gate, deployment is the proxy's own.
        let mut plain = nodes("Plain");
        plain["baseContracts"] = json!([]);
        let report = read_one(vec![plain], "Plain").report();
        assert!(
            report.contains("state owner - set at deployment, never after"),
            "{report}"
        );
        assert!(!report.contains("implementation's constructor"), "{report}");
    }

    #[test]
    fn a_call_into_another_contract_does_not_claim_where_its_address_comes_from() {
        let cands = token().candidates();
        let oracle = cands
            .iter()
            .find(|c| c.id == "asm.token.calls-ioracle")
            .expect("oracle");
        // `ClipperCallee(who).clipperCall(...)` calls an address the caller gave.
        assert!(!oracle.detail.contains("set at deployment or by an admin"));
        assert!(
            oracle.detail.contains("given by the caller"),
            "{}",
            oracle.detail
        );
    }
}
