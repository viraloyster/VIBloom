// Pulls each finished element of a top-level array out of JSON that is still
// arriving, so a node can grow on screen the moment the model has written it.

export class ArrayItems {
  private text = "";
  private pos = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private inArray = false;
  private start = -1;
  private key = "";
  private lastString = "";
  private stringStart = -1;

  constructor(private readonly field: string) {}

  push(chunk: string): unknown[] {
    this.text += chunk;
    const out: unknown[] = [];
    for (; this.pos < this.text.length; this.pos++) {
      const c = this.text[this.pos];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') {
          this.inString = false;
          this.lastString = this.text.slice(this.stringStart + 1, this.pos);
        }
        continue;
      }
      if (c === '"') {
        this.inString = true;
        this.stringStart = this.pos;
      } else if (c === ":" && this.depth === 1) {
        this.key = this.lastString;
      } else if (c === "{" || c === "[") {
        this.depth++;
        if (this.depth === 2 && c === "[" && this.key === this.field) this.inArray = true;
        else if (this.depth === 3 && this.inArray && c === "{") this.start = this.pos;
      } else if (c === "}" || c === "]") {
        if (this.depth === 3 && this.inArray && c === "}" && this.start >= 0) {
          try {
            out.push(JSON.parse(this.text.slice(this.start, this.pos + 1)));
          } catch {
            // Left to the final parse to report.
          }
          this.start = -1;
        }
        if (this.depth === 2 && this.inArray && c === "]") this.inArray = false;
        this.depth--;
      }
    }
    return out;
  }
}
