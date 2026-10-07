/**
 * 最小 Node 内建模块类型声明。
 *
 * 本项目不引入 @types/node（保持零运行时依赖、devDependencies 不为后端新增），
 * 因此这里只声明 server/ 真正用到的 API 表面，供 `tsc --noEmit` 类型检查使用。
 * 运行时由 Node ≥ 24 提供真实实现；`.d.ts` 不参与类型擦除运行。
 */

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
  argv: string[];
  exitCode: number | undefined;
  on(event: string, listener: (...args: unknown[]) => void): void;
  exit(code?: number): void;
};

declare const console: {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
  debug(...data: unknown[]): void;
};

declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;

declare class AbortController {
  readonly signal: unknown;
  abort(): void;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string);
  decode(input?: Uint8Array): string;
}

declare class URL {
  constructor(input: string, base?: string);
  protocol: string;
  username: string;
  password: string;
  hash: string;
  pathname: string;
  href: string;
}

interface Response {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: {
    get(name: string): string | null;
    getSetCookie?(): string[];
  };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer | null;
  signal?: unknown;
}

declare function fetch(input: string, init?: RequestInit): Promise<Response>;

declare class Buffer extends Uint8Array {
  static from(data: string, encoding?: string): Buffer;
  static from(data: ArrayBuffer | Uint8Array): Buffer;
  static concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
  static alloc(size: number, fill?: number): Buffer;
  static byteLength(data: string, encoding?: string): number;
  toString(encoding?: string): string;
}

interface ImportMeta {
  readonly url: string;
}

declare module 'node:crypto' {
  export interface ScryptOptions {
    N?: number;
    r?: number;
    p?: number;
    maxmem?: number;
  }
  export function scryptSync(
    password: string | Uint8Array,
    salt: string | Uint8Array,
    keylen: number,
    options?: ScryptOptions,
  ): Buffer;
  export function randomBytes(size: number): Buffer;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(): Buffer;
    digest(encoding: string): string;
  }
  export function createHash(algorithm: string): Hash;
  export interface Cipher {
    update(data: Uint8Array): Buffer;
    final(): Buffer;
  }
  export interface Decipher {
    update(data: Uint8Array): Buffer;
    final(): Buffer;
  }
  export function createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): Cipher;
  export function createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): Decipher;
}

declare module 'node:zlib' {
  export function deflateRawSync(data: Uint8Array, options?: unknown): Buffer;
  export function inflateRawSync(data: Uint8Array, options?: unknown): Buffer;
}

declare module 'node:sqlite' {
  export interface StatementResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }
  export interface StatementSync {
    run(...params: unknown[]): StatementResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module 'node:http' {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string };
    on(event: 'data', listener: (chunk: Uint8Array) => void): void;
    on(event: 'end', listener: () => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    destroy(error?: Error): void;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string | string[] | number): void;
    writeHead(statusCode: number, headers?: Record<string, string | number | string[]>): void;
    end(chunk?: string | Uint8Array): void;
    writableEnded: boolean;
    headersSent: boolean;
  }
  export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;
  export interface AddressInfo {
    address: string;
    port: number;
  }
  export interface Server {
    listen(port: number, host: string, callback?: () => void): Server;
    close(callback?: (error?: Error) => void): void;
    address(): AddressInfo | string | null;
    on(event: string, listener: (...args: unknown[]) => void): void;
    once(event: string, listener: (...args: unknown[]) => void): void;
  }
  export function createServer(listener: RequestListener): Server;
}

declare module 'node:fs' {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string): Buffer;
  export function readFileSync(path: string, encoding: string): string;
  export function statSync(path: string): {
    isDirectory(): boolean;
    isFile(): boolean;
    size: number;
    mtimeMs: number;
  };
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function extname(path: string): string;
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function normalize(path: string): string;
  export const sep: string;
}

declare module 'node:test' {
  export interface TestContext {
    after(fn: () => void | Promise<void>): void;
  }
  export function test(name: string, fn: (t: TestContext) => void | Promise<void>): Promise<void>;
  export function test(
    name: string,
    options: unknown,
    fn: (t: TestContext) => void | Promise<void>,
  ): Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): Promise<void>;
  export function before(fn: () => void | Promise<void>): void;
  export function after(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    match(value: string, regexp: RegExp, message?: string): void;
    doesNotMatch(value: string, regexp: RegExp, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    rejects(fn: () => Promise<unknown>, expected?: unknown, message?: string): Promise<void>;
    includes(haystack: string, needle: string, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
