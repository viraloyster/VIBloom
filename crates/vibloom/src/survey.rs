//! What a compiled Solidity contract says about itself, read from the
//! compiler's own syntax tree: who may call what, what it can be upgraded or
//! paused by, which other contracts it calls. These are facts about the code,
//! each with the line it comes from. What they mean for the protocol is a
//! person's call, so they become proposals, never nodes.

use crate::setup::entry_points;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Function {
    pub name: String,
    pub line: usize,
    /// Modifiers that restrict who may call: `onlyRole(MINTER_ROLE)`, `onlyOwner`.
    pub gates: Vec<String>,
    /// Every other modifier: `nonReentrant`, `whenNotPaused`, `initializer`.
    pub others: Vec<String>,
    /// Lines of the caller checks in its body (see `own_checks`):
    /// `require(wish(src, msg.sender))`, or a call to a function that has one.
    pub checks: Vec<usize>,
}

/// A state variable and what can change it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateVar {
    pub name: String,
    pub line: usize,
    /// "constant" or "immutable"; empty for a variable that can change.
    pub fixed: &'static str,
    /// This contract's own entry points that write it, directly or through
    /// its internal functions and modifiers.
    pub writers: Vec<String>,
    /// Internal functions that write it and that no entry point of this
    /// contract reaches: hooks called from inherited code.
    pub hooks: Vec<String>,
    pub in_constructor: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Contract {
    pub name: String,
    pub file: String,
    pub bases: Vec<String>,
    pub state: Vec<StateVar>,
    /// State-changing functions callable from outside, defined in this contract.
    pub functions: Vec<Function>,
    /// The same, inherited: only their names are known here.
    pub inherited: Vec<String>,
    /// `Type.member` of every call into another contract, with its line.
    pub calls: BTreeMap<String, usize>,
    /// The gate on `_authorizeUpgrade`, when the contract is upgradeable.
    pub upgrade_gate: Option<(String, usize)>,
    pub low_level: Vec<(String, usize)>,
    /// Each gate defined in this file that the contract uses, with the state
    /// variables of the contract its caller check reads: `auth` reads `wards`.
    pub guards: Vec<(String, Vec<String>)>,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn line_of(node: &Value, source: &str) -> usize {
    let start: usize = s(node, "src")
        .split(':')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    source
        .as_bytes()
        .iter()
        .take(start)
        .filter(|b| **b == b'\n')
        .count()
        + 1
}

// A modifier as written, with simple arguments: `onlyRole(MINTER_ROLE)`.
fn modifier_text(m: &Value) -> String {
    let name = m
        .pointer("/modifierName/name")
        .and_then(Value::as_str)
        .unwrap_or("?");
    let args: Vec<String> = m
        .get("arguments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|a| match s(a, "nodeType") {
            "Identifier" => s(a, "name").to_string(),
            "MemberAccess" => format!(
                "{}.{}",
                a.pointer("/expression/name")
                    .and_then(Value::as_str)
                    .unwrap_or("?"),
                s(a, "memberName")
            ),
            _ => "...".to_string(),
        })
        .collect();
    if args.is_empty() {
        name.to_string()
    } else {
        format!("{name}({})", args.join(", "))
    }
}

// A modifier that decides who may call, by the names every codebase uses:
// for a modifier whose code is not in this file.
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
    call.get("arguments")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
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
        let result = e
            .pointer("/typeDescriptions/typeString")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !(name == Some("address") || old == Some("address") || result.starts_with("address")) {
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
// that holds one of them.
fn is_caller(e: &Value, aliases: &BTreeSet<i64>) -> bool {
    let e = unwrap_address(e);
    let on = e.pointer("/expression/name").and_then(Value::as_str);
    match s(e, "nodeType") {
        "MemberAccess" => matches!(
            (on, s(e, "memberName")),
            (Some("msg"), "sender") | (Some("tx"), "origin")
        ),
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
        "Identifier" => referenced(e).is_some_and(|id| aliases.contains(&id)),
        _ => false,
    }
}

// Whether a condition depends on who the caller is. An amount compared with
// `<` or `>` (`balanceOf[msg.sender] >= wad`) and a caller compared with the
// zero address say nothing about who may call.
fn uses_caller(e: &Value, aliases: &BTreeSet<i64>) -> bool {
    match e {
        Value::Array(items) => items.iter().any(|x| uses_caller(x, aliases)),
        Value::Object(map) => {
            if is_caller(e, aliases) {
                return true;
            }
            if s(e, "nodeType") == "BinaryOperation" {
                let l = e.get("leftExpression").unwrap_or(&Value::Null);
                let r = e.get("rightExpression").unwrap_or(&Value::Null);
                match s(e, "operator") {
                    "<" | ">" | "<=" | ">=" => return false,
                    "==" | "!="
                        if (is_caller(l, aliases) && is_zero(r))
                            || (is_caller(r, aliases) && is_zero(l)) =>
                    {
                        return false;
                    }
                    _ => {}
                }
            }
            map.values().any(|x| uses_caller(x, aliases))
        }
        _ => false,
    }
}

// The locals of a body that stand for the caller: assigned exactly from it,
// or a bool computed from it.
fn caller_aliases(body: &Value) -> BTreeSet<i64> {
    let mut is_bool: BTreeMap<i64, bool> = BTreeMap::new();
    let mut from: Vec<(i64, &Value)> = Vec::new();
    walk(body, &mut |x| match s(x, "nodeType") {
        "VariableDeclarationStatement" => {
            let decls: Vec<&Value> = x
                .get("declarations")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .collect();
            if let [d] = decls.as_slice()
                && let Some(id) = node_id(d)
            {
                let ty = d
                    .pointer("/typeDescriptions/typeString")
                    .and_then(Value::as_str);
                is_bool.insert(id, ty == Some("bool"));
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
    let mut out = BTreeSet::new();
    loop {
        let before = out.len();
        for (id, e) in &from {
            let Some(b) = is_bool.get(id) else { continue };
            if !out.contains(id) && (is_caller(e, &out) || (*b && uses_caller(e, &out))) {
                out.insert(*id);
            }
        }
        if out.len() == before {
            return out;
        }
    }
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

// Inline assembly that reads the caller and can revert.
fn assembly_checks_caller(asm: &Value) -> bool {
    let mut names = BTreeSet::new();
    walk(asm, &mut |x| {
        if s(x, "nodeType") == "YulFunctionCall"
            && let Some(n) = x.pointer("/functionName/name").and_then(Value::as_str)
        {
            names.insert(n.to_string());
        }
    });
    let text = s(asm, "operations");
    let has = |n: &str| names.contains(n) || text.contains(&format!("{n}("));
    (has("caller") || has("origin")) && has("revert")
}

/// The caller checks written in one body, each with the condition it tests
/// (none for assembly or a well-known check call).
///
/// A caller check is a `require(...)` or `assert(...)` call, an `if` whose
/// branch reverts (a `revert` statement or a call to `revert`, `require` or
/// `assert`), or an inline assembly block that has both `caller()` or
/// `origin()` and `revert(`, where the condition uses the caller outside of
/// a `<`, `>`, `<=` or `>=` comparison and not only in an `==` or `!=`
/// against the zero address. The caller is `msg.sender`, `tx.origin`,
/// `_msgSender()` or `msgSender()`, or a local that is an alias of one
/// (declared or assigned exactly from it, possibly wrapped in `address(...)`
/// or `payable(...)`), or a bool local whose initial value uses the caller
/// under the same rule. A call to `_checkRole` or `_checkOwner` as a
/// statement is one too: the standard libraries check the caller there.
fn own_checks(body: &Value) -> Vec<(&Value, Option<&Value>)> {
    let aliases = caller_aliases(body);
    let mut out = Vec::new();
    walk(body, &mut |x| match s(x, "nodeType") {
        "FunctionCall" if matches!(callee_name(x), "require" | "assert") => {
            if let Some(cond) = args_of(x).first()
                && uses_caller(cond, &aliases)
            {
                out.push((x, Some(cond)));
            }
        }
        "IfStatement" => {
            let branch = |k: &str| x.get(k).is_some_and(reverts);
            if let Some(cond) = x.get("condition")
                && (branch("trueBody") || branch("falseBody"))
                && uses_caller(cond, &aliases)
            {
                out.push((x, Some(cond)));
            }
        }
        "InlineAssembly" if assembly_checks_caller(x) => out.push((x, None)),
        "ExpressionStatement" => {
            if let Some(call) = x.get("expression")
                && s(call, "nodeType") == "FunctionCall"
                && matches!(callee_name(call), "_checkRole" | "_checkOwner")
            {
                out.push((x, None));
            }
        }
        _ => {}
    });
    out
}

// The functions and modifiers of one source file, to follow calls between them.
struct File<'a> {
    defs: BTreeMap<i64, &'a Value>,
    /// Every node id in the file: a reference outside it is code from elsewhere.
    ids: BTreeSet<i64>,
    source: &'a str,
    checked: RefCell<BTreeMap<i64, bool>>,
}

impl<'a> File<'a> {
    fn new(ast: &'a Value, source: &'a str) -> Self {
        let mut defs = BTreeMap::new();
        let mut ids = BTreeSet::new();
        walk(ast, &mut |x| {
            ids.extend(node_id(x));
            if matches!(
                s(x, "nodeType"),
                "FunctionDefinition" | "ModifierDefinition"
            ) && let Some(id) = node_id(x)
            {
                defs.insert(id, x);
            }
        });
        Self {
            defs,
            ids,
            source,
            checked: RefCell::new(BTreeMap::new()),
        }
    }

    // Calls from a body to internal functions of this file. A public one is
    // an entry point with its own report, and it may be called with the
    // caller already as the argument it checks (`transferFrom(msg.sender, ...)`).
    fn local_calls(&self, body: &'a Value) -> Vec<(i64, &'a Value)> {
        let mut out = Vec::new();
        walk(body, &mut |x| {
            if s(x, "nodeType") == "FunctionCall"
                && let Some(id) = x.get("expression").and_then(referenced)
                && let Some(def) = self.defs.get(&id)
                && s(def, "nodeType") == "FunctionDefinition"
                && matches!(s(def, "visibility"), "internal" | "private")
            {
                out.push((id, x));
            }
        });
        out
    }

    fn has_check(&self, id: i64) -> bool {
        if let Some(known) = self.checked.borrow().get(&id) {
            return *known;
        }
        // A recursive call is not a check of its own.
        self.checked.borrow_mut().insert(id, false);
        let body = self.defs.get(&id).and_then(|d| d.get("body"));
        let found = body.is_some_and(|b| {
            !own_checks(b).is_empty() || self.local_calls(b).iter().any(|(c, _)| self.has_check(*c))
        });
        self.checked.borrow_mut().insert(id, found);
        found
    }

    /// The lines of the caller checks a function or modifier runs in its own
    /// body: its own, and its calls to functions of this file that check.
    fn checks(&self, def: &'a Value) -> Vec<usize> {
        let body = def.get("body").unwrap_or(&Value::Null);
        let mut out: Vec<usize> = own_checks(body)
            .iter()
            .map(|(x, _)| line_of(x, self.source))
            .chain(
                self.local_calls(body)
                    .iter()
                    .filter(|(id, _)| self.has_check(*id))
                    .map(|(_, x)| line_of(x, self.source)),
            )
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    // Every declaration the conditions of those checks refer to.
    fn check_reads(&self, def: &'a Value, seen: &mut BTreeSet<i64>, out: &mut BTreeSet<i64>) {
        let body = def.get("body").unwrap_or(&Value::Null);
        for (_, cond) in own_checks(body) {
            walk(cond.unwrap_or(&Value::Null), &mut |x| {
                out.extend(referenced(x))
            });
        }
        for (id, _) in self.local_calls(body) {
            if seen.insert(id)
                && self.has_check(id)
                && let Some(d) = self.defs.get(&id)
            {
                self.check_reads(d, seen, out);
            }
        }
    }

    // Whether code reached from here calls something defined in another file.
    fn calls_outside(&self, def: &'a Value) -> bool {
        let mut seen = BTreeSet::new();
        let mut todo = vec![def];
        while let Some(d) = todo.pop() {
            let mut found = false;
            walk(d.get("body").unwrap_or(&Value::Null), &mut |x| {
                if s(x, "nodeType") != "FunctionCall" || is_conversion(x) {
                    return;
                }
                // A call into another contract (`token.isMintable()`) is not
                // inherited code that could check the caller.
                let Some(id) = x
                    .get("expression")
                    .filter(|e| {
                        s(e, "nodeType") == "Identifier"
                            || e.pointer("/expression/name").and_then(Value::as_str)
                                == Some("super")
                    })
                    .and_then(referenced)
                else {
                    return;
                };
                // Builtins such as `require` have negative ids.
                if id >= 0 && !self.ids.contains(&id) {
                    found = true;
                } else if let Some(next) = self.defs.get(&id)
                    && seen.insert(id)
                {
                    todo.push(next);
                }
            });
            if found {
                return true;
            }
        }
        false
    }

    /// A modifier of this file restricts who may call when it checks the
    /// caller, itself or through functions of this file. When it calls code
    /// from elsewhere that may do the check, its name decides.
    fn is_gate(&self, modifier: &'a Value) -> bool {
        node_id(modifier).is_some_and(|id| self.has_check(id))
            || (self.calls_outside(modifier) && is_gate(s(modifier, "name")))
    }
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

// The declarations an expression's storage starts from: `a[i].b` -> a.
fn roots_of(expr: &Value, out: &mut Vec<i64>) {
    match s(expr, "nodeType") {
        "Identifier" => out.extend(referenced(expr)),
        "IndexAccess" | "IndexRangeAccess" => {
            roots_of(expr.get("baseExpression").unwrap_or(&Value::Null), out);
        }
        "MemberAccess" => roots_of(expr.get("expression").unwrap_or(&Value::Null), out),
        "TupleExpression" => {
            for c in expr
                .get("components")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                roots_of(c, out);
            }
        }
        _ => {}
    }
}

// Every declaration a piece of code writes to: assignments, `delete`, `++`
// and `--`, `push` and `pop`. A local `storage` pointer counts as the
// variable it points into.
fn writes_of(body: &Value) -> BTreeSet<i64> {
    let mut alias: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
    walk(body, &mut |x| {
        if s(x, "nodeType") != "VariableDeclarationStatement" {
            return;
        }
        let decls: Vec<&Value> = x
            .get("declarations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|d| d.is_object())
            .collect();
        if let ([d], Some(init)) = (decls.as_slice(), x.get("initialValue"))
            && s(d, "storageLocation") == "storage"
            && let Some(id) = node_id(d)
        {
            let mut to = Vec::new();
            roots_of(init, &mut to);
            alias.insert(id, to);
        }
    });
    let mut direct = Vec::new();
    walk(body, &mut |x| match s(x, "nodeType") {
        "Assignment" => roots_of(x.get("leftHandSide").unwrap_or(&Value::Null), &mut direct),
        "UnaryOperation" if matches!(s(x, "operator"), "delete" | "++" | "--") => {
            roots_of(x.get("subExpression").unwrap_or(&Value::Null), &mut direct);
        }
        "FunctionCall" => {
            if let Some(e) = x.get("expression")
                && s(e, "nodeType") == "MemberAccess"
                && matches!(s(e, "memberName"), "push" | "pop")
            {
                roots_of(e.get("expression").unwrap_or(&Value::Null), &mut direct);
            }
        }
        _ => {}
    });
    // A pointer may point into another pointer; a few hops is plenty.
    let mut out = BTreeSet::new();
    let mut todo = direct;
    for _ in 0..8 {
        let mut next = Vec::new();
        for id in todo {
            match alias.get(&id) {
                Some(to) => next.extend(to.iter().copied()),
                None => {
                    out.insert(id);
                }
            }
        }
        if next.is_empty() {
            break;
        }
        todo = next;
    }
    out
}

// The functions and modifiers of this file that a function runs: the ones it
// calls by name, the `super` ones, and its modifiers.
fn callees_of(func: &Value) -> BTreeSet<i64> {
    let mut out = BTreeSet::new();
    for m in func
        .get("modifiers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        out.extend(m.get("modifierName").and_then(referenced));
    }
    walk(func.get("body").unwrap_or(&Value::Null), &mut |x| {
        if s(x, "nodeType") != "FunctionCall" {
            return;
        }
        let Some(e) = x.get("expression") else { return };
        match s(e, "nodeType") {
            "Identifier" => out.extend(referenced(e)),
            "MemberAccess"
                if e.pointer("/expression/name").and_then(Value::as_str) == Some("super") =>
            {
                out.extend(referenced(e));
            }
            _ => {}
        }
    });
    out
}

// Records a call into another contract, or a low-level call, at node `x`.
fn note_call(
    x: &Value,
    source: &str,
    calls: &mut BTreeMap<String, usize>,
    low_level: &mut Vec<(String, usize)>,
) {
    if s(x, "nodeType") != "FunctionCall" {
        return;
    }
    let Some(mut e) = x.get("expression") else {
        return;
    };
    // `t.call{value: v}(data)`, and before solc 0.6.2 `t.call.value(v)(data)`.
    loop {
        let inner = e.get("expression").unwrap_or(&Value::Null);
        match s(e, "nodeType") {
            "FunctionCallOptions" => e = inner,
            "FunctionCall"
                if s(inner, "nodeType") == "MemberAccess"
                    && matches!(s(inner, "memberName"), "value" | "gas") =>
            {
                e = inner.get("expression").unwrap_or(&Value::Null);
            }
            _ => break,
        }
    }
    if s(e, "nodeType") != "MemberAccess" {
        return;
    }
    let member = s(e, "memberName");
    let on = e
        .pointer("/expression/typeDescriptions/typeString")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(target) = on.strip_prefix("contract ") {
        calls
            .entry(format!("{target}.{member}"))
            .or_insert_with(|| line_of(x, source));
    } else if matches!(member, "call" | "delegatecall" | "staticcall") && on.starts_with("address")
    {
        low_level.push((member.to_string(), line_of(x, source)));
    }
}

/// The contract a compiled artifact is named after, read from its syntax
/// tree. None for an interface, a library, or an artifact built without one
/// (`forge build --ast` writes it).
pub fn read(artifact: &Value, name: &str, source: &str) -> Option<Contract> {
    let ast = artifact.get("ast")?;
    let def = ast
        .get("nodes")?
        .as_array()?
        .iter()
        .find(|n| s(n, "nodeType") == "ContractDefinition" && s(n, "name") == name)?;
    if s(def, "contractKind") != "contract" || def.get("abstract") == Some(&Value::Bool(true)) {
        return None;
    }
    let bases = def
        .get("baseContracts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|b| b.pointer("/baseName/name").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let file = File::new(ast, source);
    // The modifiers written in this file. Two contracts of one file can each
    // define `auth`, so an invocation is resolved by id when it has one.
    let by_name: BTreeMap<&str, &Value> = file
        .defs
        .values()
        .filter(|d| s(d, "nodeType") == "ModifierDefinition")
        .map(|d| (s(d, "name"), *d))
        .collect();
    let local_modifier = |m: &Value| -> Option<&Value> {
        match m.get("modifierName").and_then(referenced) {
            Some(id) => file
                .defs
                .get(&id)
                .copied()
                .filter(|d| s(d, "nodeType") == "ModifierDefinition"),
            None => by_name
                .get(m.pointer("/modifierName/name").and_then(Value::as_str)?)
                .copied(),
        }
    };
    let gate = |m: &Value| match local_modifier(m) {
        Some(d) => file.is_gate(d),
        None => is_gate(&modifier_text(m)),
    };
    // What each function and modifier of this file writes and runs, by id.
    let mut code: BTreeMap<i64, (BTreeSet<i64>, BTreeSet<i64>)> = BTreeMap::new();
    walk(ast, &mut |x| {
        if matches!(
            s(x, "nodeType"),
            "FunctionDefinition" | "ModifierDefinition"
        ) && let Some(id) = node_id(x)
        {
            code.insert(
                id,
                (
                    writes_of(x.get("body").unwrap_or(&Value::Null)),
                    callees_of(x),
                ),
            );
        }
    });
    // Everything a function writes, through whatever of this file it runs.
    let reach = |start: i64| -> BTreeSet<i64> {
        let mut seen = BTreeSet::new();
        let mut written = BTreeSet::new();
        let mut todo = vec![start];
        while let Some(id) = todo.pop() {
            if !seen.insert(id) {
                continue;
            }
            if let Some((w, c)) = code.get(&id) {
                written.extend(w.iter().copied());
                todo.extend(c.iter().copied());
            }
        }
        written
    };
    let mut functions = Vec::new();
    // For every function of the contract: its name, whether it is an entry
    // point, and what it writes.
    let mut writers: Vec<(String, bool, BTreeSet<i64>, BTreeSet<i64>)> = Vec::new();
    let mut calls = BTreeMap::new();
    let mut low_level = Vec::new();
    let mut upgrade_gate = None;
    // Each gate of this file the contract uses, with what its check reads.
    let mut guarded: Vec<(String, BTreeSet<i64>)> = Vec::new();
    for n in def
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        // A modifier's own calls into other contracts count too: the check
        // "is the caller an admin of that token" is a call to the token.
        if s(n, "nodeType") == "ModifierDefinition" {
            walk(n.get("body").unwrap_or(&Value::Null), &mut |x| {
                note_call(x, source, &mut calls, &mut low_level);
            });
        }
        if s(n, "nodeType") != "FunctionDefinition" {
            continue;
        }
        let mut gates = Vec::new();
        let mut others = Vec::new();
        for m in n
            .get("modifiers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if !gate(m) {
                others.push(modifier_text(m));
                continue;
            }
            gates.push(modifier_text(m));
            if let Some(d) = local_modifier(m)
                && !guarded.iter().any(|(g, _)| g == s(d, "name"))
            {
                let mut reads = BTreeSet::new();
                file.check_reads(d, &mut BTreeSet::new(), &mut reads);
                guarded.push((s(d, "name").to_string(), reads));
            }
        }
        if s(n, "name") == "_authorizeUpgrade" {
            upgrade_gate = Some((
                if gates.is_empty() {
                    "nobody in particular".to_string()
                } else {
                    gates.join(" and ")
                },
                line_of(n, source),
            ));
        }
        walk(n.get("body").unwrap_or(&Value::Null), &mut |x| {
            note_call(x, source, &mut calls, &mut low_level);
        });
        let outside = matches!(s(n, "visibility"), "external" | "public");
        let changes = matches!(s(n, "stateMutability"), "nonpayable" | "payable");
        let kind = kind_of(n);
        let entry = matches!(kind, "function" | "fallback" | "receive") && outside && changes;
        let name = match kind {
            "function" => s(n, "name"),
            k => k,
        };
        if let Some(id) = node_id(n) {
            let direct = code.get(&id).map(|c| c.0.clone()).unwrap_or_default();
            writers.push((name.to_string(), entry, reach(id), direct));
        }
        if entry {
            functions.push(Function {
                name: name.to_string(),
                line: line_of(n, source),
                gates,
                others,
                checks: file.checks(n),
            });
        }
    }
    let mut state = Vec::new();
    for v in def
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|v| s(v, "nodeType") == "VariableDeclaration")
    {
        let Some(id) = node_id(v) else { continue };
        let fixed = if v.get("constant") == Some(&Value::Bool(true)) {
            "constant"
        } else if s(v, "mutability") == "immutable" {
            "immutable"
        } else {
            ""
        };
        let by_entry: Vec<String> = uniq(
            writers
                .iter()
                .filter(|(_, entry, reached, _)| *entry && reached.contains(&id))
                .map(|(name, ..)| name.as_str()),
        )
        .into_iter()
        .map(str::to_string)
        .collect();
        // A function that writes it without being reached from an entry point
        // of this contract runs when inherited code calls it.
        let hooks: Vec<String> = writers
            .iter()
            .filter(|(name, entry, _, direct)| {
                !*entry
                    && name != "constructor"
                    && direct.contains(&id)
                    && !writers
                        .iter()
                        .any(|(_, e, reached, _)| *e && reached.contains(&id))
            })
            .map(|(name, ..)| name.clone())
            .collect();
        state.push(StateVar {
            name: s(v, "name").to_string(),
            line: line_of(v, source),
            fixed,
            writers: by_entry,
            hooks,
            in_constructor: writers
                .iter()
                .any(|(name, _, reached, _)| name == "constructor" && reached.contains(&id)),
        });
    }
    let guards = guarded
        .into_iter()
        .map(|(g, reads)| {
            let vars = def
                .get("nodes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|v| s(v, "nodeType") == "VariableDeclaration")
                .filter(|v| node_id(v).is_some_and(|id| reads.contains(&id)))
                .map(|v| s(v, "name").to_string())
                .collect();
            (g, vars)
        })
        .collect();
    let own: BTreeSet<&str> = functions.iter().map(|f| f.name.as_str()).collect();
    let inherited = entry_points(artifact)
        .into_iter()
        .filter(|n| !own.contains(n.as_str()))
        .collect();
    Some(Contract {
        name: name.to_string(),
        file: s(ast, "absolutePath").to_string(),
        bases,
        state,
        functions,
        inherited,
        calls,
        upgrade_gate,
        low_level,
        guards,
    })
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

impl Contract {
    fn at(&self, line: usize) -> String {
        format!("{}:{line}", self.file)
    }

    fn has_base(&self, part: &str) -> bool {
        self.bases.iter().any(|b| b.contains(part))
    }

    // Who gets through a function: its gates, or where its body checks.
    fn who(&self, f: &Function) -> String {
        if !f.gates.is_empty() {
            f.gates.join(", ")
        } else if !f.checks.is_empty() {
            format!(
                "checks the caller at {}",
                f.checks
                    .iter()
                    .map(|l| self.at(*l))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        } else {
            "anyone".to_string()
        }
    }

    pub fn candidates(&self) -> Vec<Candidate> {
        let mut out = Vec::new();
        let c = &self.name;
        let k = id_part(c);
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
                evidence: fs.iter().map(|f| self.at(f.line)).collect(),
            });
        }
        let gated: Vec<&Function> = self
            .functions
            .iter()
            .filter(|f| !f.gates.is_empty() || !f.checks.is_empty())
            .collect();
        if !gated.is_empty() {
            let each: Vec<String> = gated
                .iter()
                .map(|f| format!("{} ({})", f.name, self.who(f)))
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
                evidence: gated.iter().map(|f| self.at(f.line)).collect(),
            });
        }
        // Who passes a gate of this file is itself state: whoever writes it
        // decides who gets through.
        for (gate, vars) in &self.guards {
            let writers = uniq(
                self.state
                    .iter()
                    .filter(|v| vars.contains(&v.name))
                    .flat_map(|v| v.writers.iter().map(String::as_str)),
            );
            let (Some(first), false) = (vars.first(), writers.is_empty()) else {
                continue;
            };
            let fs: Vec<&Function> = self
                .functions
                .iter()
                .filter(|f| writers.contains(&f.name.as_str()))
                .collect();
            let each: Vec<String> = fs
                .iter()
                .map(|f| format!("{} ({})", f.name, self.who(f)))
                .collect();
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.{}", id_part(first)),
                title: format!(
                    "{c}: {} {} who passes {gate} ({})",
                    some(&writers),
                    if writers.len() == 1 { "decides" } else { "decide" },
                    vars.join(", ")
                ),
                detail: format!(
                    "{gate} lets through whoever {} records, and these can change it: {}. Each is only as safe as who can call it.",
                    vars.join(", "),
                    uniq(each.iter().map(String::as_str)).join("; ")
                ),
                evidence: fs.iter().map(|f| self.at(f.line)).collect(),
            });
        }
        if self.has_base("AccessControl") {
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.role-admin"),
                title: format!("{c}: whoever holds a role's admin role can give that role to anyone"),
                detail: "grantRole and revokeRole are inherited: DEFAULT_ADMIN_ROLE administers every role unless the code sets another admin, so each trusted role is only as safe as its admin.".into(),
                evidence: vec![self.file.clone()],
            });
        }
        if self.has_base("Ownable") {
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.owner-transfer"),
                title: format!("{c}: the owner can hand ownership to anyone"),
                detail: "transferOwnership is inherited: everything the owner is trusted with moves with it.".into(),
                evidence: vec![self.file.clone()],
            });
        }
        for f in self
            .functions
            .iter()
            .filter(|f| f.gates.is_empty() && f.others.iter().any(|m| m.starts_with("initializer")))
        {
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.{}", id_part(&f.name)),
                title: format!("{c}: {} was called by the deployer before anyone else could", f.name),
                detail: "It has no access check and runs once: whoever calls it first sets the roles. Check the deployment transaction of each proxy.".into(),
                evidence: vec![self.at(f.line)],
            });
        }
        if let Some((gate, line)) = &self.upgrade_gate {
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.upgrade"),
                title: format!("{c}: whoever passes {gate} can replace all of its logic"),
                detail: "The contract is upgradeable: an upgrade can change every rule the other nodes rely on, so each of them rests on this.".into(),
                evidence: vec![self.at(*line)],
            });
        }
        let open: Vec<&Function> = self
            .functions
            .iter()
            .filter(|f| {
                f.gates.is_empty() && !f.others.iter().any(|m| m.starts_with("initializer"))
            })
            .collect();
        // Inherited functions that the standard libraries gate themselves, or
        // that only let a caller give up its own role.
        const GATED_UPSTREAM: [&str; 8] = [
            "grantRole",
            "revokeRole",
            "renounceRole",
            "upgradeTo",
            "upgradeToAndCall",
            "transferOwnership",
            "renounceOwnership",
            "acceptOwnership",
        ];
        let inherited_open: Vec<&str> = self
            .inherited
            .iter()
            .map(String::as_str)
            .filter(|n| !GATED_UPSTREAM.contains(n))
            .collect();
        if !open.is_empty() || !inherited_open.is_empty() {
            let names = uniq(
                open.iter()
                    .map(|f| f.name.as_str())
                    .chain(inherited_open.iter().copied()),
            );
            out.push(Candidate {
                invariant: true,
                id: format!("inv.{k}.books"),
                title: format!("{c}: its books stay consistent whatever anyone calls"),
                detail: format!(
                    "Callable without a role of this contract's own: {}. This is the surface an invariant test's handler has to cover.",
                    names.join(", ")
                ),
                evidence: if open.is_empty() {
                    vec![self.file.clone()]
                } else {
                    open.iter().map(|f| self.at(f.line)).collect()
                },
            });
        }
        // One assumption per contract it calls into, naming what it calls.
        let mut by_target: BTreeMap<&str, Vec<(&str, usize)>> = BTreeMap::new();
        for (call, line) in &self.calls {
            let (target, member) = call.split_once('.').unwrap_or((call, ""));
            by_target.entry(target).or_default().push((member, *line));
        }
        for (target, members) in &by_target {
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.calls-{}", id_part(target)),
                title: format!(
                    "{c}: {target} behaves as its interface says ({})",
                    uniq(members.iter().map(|(m, _)| *m)).join(", ")
                ),
                detail: "The contract calls into another one and takes what it does and returns on trust. Which contract is at that address is set at deployment or by an admin.".into(),
                evidence: members.iter().map(|(_, l)| self.at(*l)).collect(),
            });
        }
        for (kind, line) in &self.low_level {
            out.push(Candidate {
                invariant: false,
                id: format!("asm.{k}.low-level-{kind}"),
                title: format!("{c}: the target of its {kind} is trusted"),
                detail: "A low-level call runs whatever code is at the target address.".into(),
                evidence: vec![self.at(*line)],
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

    /// The facts, for a person or an agent to read before proposing anything.
    pub fn report(&self) -> String {
        let mut out = vec![format!("{} ({})", self.name, self.file)];
        if !self.bases.is_empty() {
            out.push(format!("  inherits: {}", self.bases.join(", ")));
        }
        for f in &self.functions {
            let mut line = format!("  {}:{} {}", self.file, f.line, f.name);
            line.push_str(&if f.gates.is_empty() {
                " - anyone".to_string()
            } else {
                format!(" - {}", f.gates.join(", "))
            });
            if !f.checks.is_empty() {
                let at: Vec<String> = f.checks.iter().map(|l| format!(":{l}")).collect();
                line.push_str(&format!(", checks the caller at {}", at.join(", ")));
            }
            if !f.others.is_empty() {
                line.push_str(&format!(" [{}]", f.others.join(", ")));
            }
            out.push(line);
        }
        if !self.inherited.is_empty() {
            out.push(format!(
                "  inherited, callable: {}",
                self.inherited.join(", ")
            ));
        }
        for v in &self.state {
            let how = if !v.fixed.is_empty() {
                v.fixed.to_string()
            } else if !v.writers.is_empty() {
                format!("written by {}", v.writers.join(", "))
            } else if !v.hooks.is_empty() {
                format!(
                    "written inside {} (run by inherited code)",
                    v.hooks.join(", ")
                )
            } else if v.in_constructor {
                "set in the constructor, never after".to_string()
            } else {
                "never written by this contract's own code".to_string()
            };
            out.push(format!(
                "  {}:{} state {} - {how}",
                self.file, v.line, v.name
            ));
        }
        if let Some((gate, line)) = &self.upgrade_gate {
            out.push(format!("  {}:{line} upgradeable by {gate}", self.file));
        }
        for (call, line) in &self.calls {
            out.push(format!("  {}:{line} calls {call}", self.file));
        }
        for (kind, line) in &self.low_level {
            out.push(format!("  {}:{line} low-level {kind}", self.file));
        }
        out.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // The shape solc writes, cut down to what is read.
    fn artifact() -> (Value, &'static str) {
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
        let ast = json!({ "absolutePath": "src/Token.sol", "nodes": [
            { "nodeType": "ContractDefinition", "name": "IOracle", "contractKind": "interface", "nodes": [] },
            { "nodeType": "ContractDefinition", "name": "Token", "contractKind": "contract", "abstract": false,
              "baseContracts": [{ "baseName": { "name": "ERC20Upgradeable" } }, { "baseName": { "name": "UUPSUpgradeable" } }],
              "nodes": [
                func("mint", "public", json!([gate("MINTER_ROLE")]), json!({})),
                func("pause", "external", json!([gate("PAUSER_ROLE"), { "modifierName": { "name": "nonReentrant" } }]), json!({})),
                func("sweep", "external", json!([]), oracle_call),
                func("_authorizeUpgrade", "internal", json!([gate("UPGRADER_ROLE")]), json!({})),
              ] }
        ]});
        let abi = json!([
            { "type": "function", "name": "mint", "stateMutability": "nonpayable" },
            { "type": "function", "name": "pause", "stateMutability": "nonpayable" },
            { "type": "function", "name": "sweep", "stateMutability": "nonpayable" },
            { "type": "function", "name": "transfer", "stateMutability": "nonpayable" },
            { "type": "function", "name": "balanceOf", "stateMutability": "view" }
        ]);
        (
            json!({ "ast": ast, "abi": abi, "bytecode": { "object": "0x60" } }),
            source,
        )
    }

    #[test]
    fn reads_who_may_call_what_and_where() {
        let (a, source) = artifact();
        let c = read(&a, "Token", source).expect("contract");
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
        assert_eq!(c.inherited, vec!["transfer"]);
        assert_eq!(c.upgrade_gate, Some(("onlyRole(UPGRADER_ROLE)".into(), 5)));
        assert_eq!(c.calls.get("IOracle.latestAnswer"), Some(&4));
        assert!(read(&a, "IOracle", source).is_none());
    }

    #[test]
    fn a_modifier_that_never_looks_at_the_caller_is_no_access_check() {
        let source = "contract C {\n  function f() {}\n}\n";
        // No `referencedDeclaration` on the invocations: found by name.
        let modifier = |name: &str, body: Value| json!({ "nodeType": "ModifierDefinition", "id": name.len(), "name": name, "body": body });
        let uses = |name: &str| json!({ "modifierName": { "name": name }, "arguments": [] });
        let ast = json!({ "absolutePath": "src/C.sol", "nodes": [
            { "nodeType": "ContractDefinition", "name": "C", "contractKind": "contract", "nodes": [
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
            ] }
        ]});
        let a = json!({ "ast": ast, "abi": [], "bytecode": { "object": "0x60" } });
        let c = read(&a, "C", source).expect("contract");
        assert_eq!(
            c.functions[0].gates,
            vec!["keeper", "onlyOwner", "restricted"]
        );
        assert_eq!(
            c.functions[0].others,
            vec!["onlyMintableToken", "onlyListed", "onlyInitializing"]
        );
    }

    #[test]
    fn says_what_can_change_each_state_variable() {
        let source = "contract C {}\n";
        let ident = |id: i64| json!({ "nodeType": "Identifier", "referencedDeclaration": id });
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
              "initialValue": { "nodeType": "IndexAccess", "baseExpression": ident(2) } },
            assign(json!({ "nodeType": "MemberAccess", "memberName": "amount", "expression": ident(20) }))
        ]});
        let calls_account = json!({ "statements": [
            { "nodeType": "FunctionCall", "expression": ident(12) }
        ]});
        let bump = json!({ "statements": [
            { "nodeType": "UnaryOperation", "operator": "++", "subExpression": ident(5) }
        ]});
        let ast = json!({ "absolutePath": "src/C.sol", "nodes": [
            { "nodeType": "ContractDefinition", "name": "C", "contractKind": "contract", "nodes": [
                var(1, "limit", json!({})),
                var(2, "minted", json!({})),
                var(3, "ROLE", json!({ "constant": true })),
                var(4, "owner", json!({})),
                var(5, "last", json!({})),
                var(6, "token", json!({ "mutability": "immutable" })),
                var(7, "unused", json!({})),
                func(10, "function", "setLimit", "external", json!({ "s": [assign(ident(1))] })),
                func(11, "function", "mint", "external", calls_account),
                func(12, "function", "_account", "internal", through_pointer),
                func(13, "constructor", "", "public", json!({ "s": [assign(ident(4))] })),
                func(14, "function", "_update", "internal", bump),
            ] }
        ]});
        let a = json!({ "ast": ast, "abi": [], "bytecode": { "object": "0x60" } });
        let c = read(&a, "C", source).expect("contract");
        let by_name = |n: &str| c.state.iter().find(|v| v.name == n).expect("variable");
        assert_eq!(by_name("limit").writers, vec!["setLimit"]);
        assert_eq!(by_name("minted").writers, vec!["mint"]);
        assert_eq!(by_name("ROLE").fixed, "constant");
        assert_eq!(by_name("token").fixed, "immutable");
        assert!(by_name("owner").in_constructor && by_name("owner").writers.is_empty());
        assert_eq!(by_name("last").hooks, vec!["_update"]);
        let report = c.report();
        assert!(
            report.contains("state limit - written by setLimit"),
            "{report}"
        );
        assert!(report.contains("state owner - set in the constructor, never after"));
        assert!(report.contains("state last - written inside _update (run by inherited code)"));
        assert!(report.contains("state unused - never written by this contract's own code"));
    }

    #[test]
    fn turns_the_facts_into_candidates_with_their_lines() {
        let (a, source) = artifact();
        let c = read(&a, "Token", source).expect("contract");
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
    fn lit(v: &str) -> Value {
        json!({ "nodeType": "Literal", "value": v })
    }
    fn call(f: Value, args: Vec<Value>, line: usize) -> Value {
        json!({ "nodeType": "FunctionCall", "kind": "functionCall", "expression": f,
                "arguments": args, "src": at(line) })
    }
    fn require(cond: Value, line: usize) -> Value {
        call(id("require", -18), vec![cond], line)
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
    fn uses(name: &str, refd: i64) -> Value {
        json!({ "modifierName": { "nodeType": "Identifier", "name": name, "referencedDeclaration": refd } })
    }
    fn read_one(contracts: Vec<Value>, name: &str) -> Contract {
        let source = "x\n".repeat(80);
        let ast = json!({ "absolutePath": "src/vat.sol", "nodes": contracts });
        let a = json!({ "ast": ast, "abi": [], "bytecode": { "object": "0x60" } });
        read(&a, name, &source).expect("contract")
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
            func(13, "file", "external", 13, auth.clone(), body(vec![])),
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
                 body(vec![json!({ "nodeType": "ExpressionStatement", "expression": call(id("_auth", 60), vec![], 29) })])),
            func(30, "viaPublic", "external", 30, none.clone(),
                 body(vec![call(id("burn", 19), vec![sender()], 31)])),
            func(32, "std", "external", 32, none.clone(),
                 body(vec![json!({ "nodeType": "ExpressionStatement", "src": at(33),
                                   "expression": call(id("_checkOwner", 999), vec![], 33) })])),
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
        assert_eq!(
            access.title,
            "Vat: each restricted function reverts for a caller that should not get through"
        );
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
    fn a_local_modifier_is_a_gate_by_what_it_checks_and_resolved_by_id() {
        let gov = |cid: &str, name: &str, mods: Value| {
            json!({ "nodeType": "ContractDefinition", "name": cid, "contractKind": "contract", "nodes": [
                func(1, name, "external", 1, mods, body(vec![])) ] })
        };
        let modifier = |mid: i64, name: &str, b: Value| json!({ "nodeType": "ModifierDefinition", "id": mid, "name": name, "body": b });
        let call_stmt = |f: Value| json!({ "nodeType": "ExpressionStatement", "expression": call(f, vec![], 3) });
        let helpers = json!({ "nodeType": "ContractDefinition", "name": "Base", "contractKind": "contract", "nodes": [
            // `modifier onlyGov() { _onlyGov(); _; }`
            modifier(70, "onlyGov", body(vec![call_stmt(id("_onlyGov", 71))])),
            func(71, "_onlyGov", "internal", 2, json!([]),
                 body(vec![require(bin("==", sender(), id("gov", 72)), 3)])),
            // Calls code from another file: its name decides.
            modifier(73, "onlyKeeper", body(vec![call_stmt(id("_checkKeeper", 999))])),
            modifier(74, "whenReady", body(vec![call_stmt(id("_ready", 998))])),
            // Two contracts of one file, each with its own `auth`.
            modifier(75, "auth", body(vec![require(bin("==", index(id("wards", 76), sender()), lit("1")), 4)])),
            modifier(77, "auth", body(vec![require(bin("==", id("live", 78), lit("1")), 5)])),
        ] });
        let gates = |mods: Value| {
            let c = read_one(vec![helpers.clone(), gov("G", "f", mods)], "G");
            c.functions[0].gates.clone()
        };
        assert_eq!(gates(json!([uses("onlyGov", 70)])), vec!["onlyGov"]);
        assert_eq!(gates(json!([uses("onlyKeeper", 73)])), vec!["onlyKeeper"]);
        assert_eq!(gates(json!([uses("whenReady", 74)])), Vec::<String>::new());
        assert_eq!(gates(json!([uses("auth", 75)])), vec!["auth"]);
        assert_eq!(gates(json!([uses("auth", 77)])), Vec::<String>::new());
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
        let c = read_one(
            vec![
                json!({ "nodeType": "ContractDefinition", "name": "C", "contractKind": "contract", "nodes": [
            func(1, "sweep", "external", 1, json!([]), body(vec![
                call(options(member("call", "address")), vec![], 8),
                call(options(member("price", "contract IOracle")), vec![], 9),
            ])),
            fallback, receive, ctor, old_fallback,
        ] }),
            ],
            "C",
        );
        assert_eq!(c.calls.get("IOracle.price"), Some(&9));
        assert_eq!(
            c.low_level,
            vec![("call".to_string(), 8), ("call".to_string(), 3)]
        );
        let names: Vec<&str> = c.functions.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["sweep", "fallback", "receive", "fallback"]);
    }
}
