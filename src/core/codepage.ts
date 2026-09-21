import { GENERATED_CODE_PAGES, GeneratedCodePage } from './codepages.generated';

/**
 * Byte <-> character for the single-byte code pages a mainframe dataset is written in.
 *
 * One byte is one character: that is the whole model the viewer's columns rest on, so a multi-byte
 * encoding (UTF-8, the DBCS pages) is deliberately absent rather than approximated. The tables come
 * from .NET's own code pages - the ones the runtime decodes with - through tools/gen-codepages.ps1.
 */
export class CodePage {
    /** What a byte with no printable character is shown as. */
    static readonly PLACEHOLDER = '.';

    private readonly byteOfChar = new Map<string, number>();
    private readonly displayChars: string[];

    private constructor(private readonly definition: GeneratedCodePage) {
        this.displayChars = new Array<string>(256);

        for (let b = 0; b < 256; b++) {
            const ch = definition.chars[b];

            // First byte wins: a code page can decode two bytes to the same character (unmapped ones
            // all come back as U+FFFD), and encoding has to pick one.
            if (!this.byteOfChar.has(ch)) this.byteOfChar.set(ch, b);

            this.displayChars[b] = isPrintable(ch) ? ch : CodePage.PLACEHOLDER;
        }
    }

    get id(): string { return this.definition.id; }
    get ccsid(): number { return this.definition.ccsid; }
    get label(): string { return this.definition.label; }
    get isEbcdic(): boolean { return this.definition.ebcdic; }

    /** The bytes this code page writes \n, \r and a space as - what line-sequential reading needs. */
    get lf(): number { return this.byteOfChar.get('\n') ?? 0x0a; }
    get cr(): number { return this.byteOfChar.get('\r') ?? 0x0d; }
    get space(): number { return this.byteOfChar.get(' ') ?? 0x20; }

    /** The characters the bytes stand for, unprintable ones included. Use for searching, not display. */
    decode(bytes: Uint8Array): string {
        let text = '';
        for (const b of bytes) text += this.definition.chars[b];
        return text;
    }

    /** The same, with everything unprintable replaced by a dot, for a grid cell. */
    render(bytes: Uint8Array): string {
        let text = '';
        for (const b of bytes) text += this.displayChars[b];
        return text;
    }

    /**
     * The bytes that spell `text` in this code page. A character the code page has no byte for is
     * reported rather than silently written as a question mark: it means the search would look for
     * something the file cannot contain, which the user wants to hear about.
     */
    encode(text: string): { bytes: Buffer; unmapped: string[] } {
        const bytes = Buffer.alloc(text.length);
        const unmapped: string[] = [];

        for (let i = 0; i < text.length; i++) {
            const b = this.byteOfChar.get(text[i]);
            if (b === undefined) {
                unmapped.push(text[i]);
                bytes[i] = this.space;
            } else {
                bytes[i] = b;
            }
        }

        return { bytes, unmapped };
    }

    private static readonly instances = new Map<string, CodePage>();

    static all(): CodePage[] {
        return GENERATED_CODE_PAGES.map(definition => CodePage.byId(definition.id)!);
    }

    /**
     * The code page named by an id (`ibm037`), a CCSID (`273`), or one of the spellings a user is
     * likely to type (`cp037`, `IBM-037`, `037`). Undefined when there is no such single-byte page.
     */
    static find(name: string): CodePage | undefined {
        const wanted = normalise(name);

        for (const definition of GENERATED_CODE_PAGES) {
            if (normalise(definition.id) === wanted) return CodePage.byId(definition.id);
            if (String(definition.ccsid) === wanted) return CodePage.byId(definition.id);
            // `ibm037` also answers to `037`, `37`, `cp037`, `ibm-037`: normalise() has already
            // dropped the punctuation, so what is left is a number that may carry leading zeroes.
            if (/^\d+$/.test(wanted) && Number(wanted) === definition.ccsid) return CodePage.byId(definition.id);
        }

        return undefined;
    }

    /** The code page named, or the fallback, or EBCDIC 037 - never undefined. */
    static resolve(name: string | undefined, fallback?: string): CodePage {
        return (name !== undefined ? CodePage.find(name) : undefined)
            ?? (fallback !== undefined ? CodePage.find(fallback) : undefined)
            ?? CodePage.byId('ibm037')!;
    }

    private static byId(id: string): CodePage | undefined {
        const existing = CodePage.instances.get(id);
        if (existing) return existing;

        const definition = GENERATED_CODE_PAGES.find(candidate => candidate.id === id);
        if (!definition) return undefined;

        const instance = new CodePage(definition);
        CodePage.instances.set(id, instance);
        return instance;
    }
}

function normalise(name: string): string {
    return name.trim().toLowerCase().replace(/[-_\s]/g, '').replace(/^(cp|ibm|ccsid|windows)/, '');
}

function isPrintable(ch: string): boolean {
    const code = ch.codePointAt(0)!;

    if (code < 0x20 || code === 0x7f) return false;          // C0 controls and DEL
    if (code >= 0x80 && code <= 0x9f) return false;          // C1 controls
    if (code === 0xfffd) return false;                       // the byte has no character here
    return true;
}
