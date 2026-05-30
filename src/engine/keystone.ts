// Typed wrapper around the from-source true-WASM Keystone build
// (vendor-wasm/keystone-core.js, factory `MKeystone`). Framework-agnostic:
// it receives an already-instantiated Emscripten module and turns assembly
// text into machine-code bytes, surfacing assembler errors cleanly.

/** The subset of the Emscripten module surface we rely on. */
export interface KeystoneModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  ccall(name: string, returnType: string, argTypes: string[], args: unknown[]): number;
  getValue(ptr: number, type: string): number;
  stringToUTF8(str: string, ptr: number, maxBytes: number): void;
  UTF8ToString(ptr: number): string;
}

/** Async factory exported by keystone-core.js (`MKeystone`). */
export type KeystoneFactory = (overrides?: Record<string, unknown>) => Promise<KeystoneModule>;

export type AssembleResult =
  | { ok: true; bytes: Uint8Array; count: number }
  | { ok: false; error: string; errno: number };

/**
 * A live Keystone handle for one (arch, mode). Cheap to keep around for the
 * lifetime of the app; call close() when done.
 */
export class Keystone {
  private readonly m: KeystoneModule;
  private readonly handle: number;
  private closed = false;

  constructor(module: KeystoneModule, arch: number, mode: number) {
    this.m = module;
    const hp = module._malloc(4);
    try {
      const rc = module.ccall('ks_open', 'number', ['number', 'number', 'pointer'], [arch, mode, hp]);
      if (rc !== 0) throw new Error(`ks_open failed (rc=${rc})`);
      this.handle = module.getValue(hp, '*');
    } finally {
      module._free(hp);
    }
  }

  /**
   * Assemble `program` as if loaded at `baseAddr`. Returns the raw bytes on
   * success, or a Keystone error message (e.g. "Invalid mnemonic") on failure.
   */
  assemble(program: string, baseAddr: number): AssembleResult {
    if (this.closed) throw new Error('Keystone handle is closed');
    const m = this.m;
    const ip = m._malloc(4); // -> encoded bytes pointer
    const sp = m._malloc(4); // -> size
    const cp = m._malloc(4); // -> statement count
    const blen = lengthBytesUTF8(program) + 1;
    const bp = m._malloc(blen);
    m.stringToUTF8(program, bp, blen);
    try {
      // ks_asm's `address` is a single i64 param in this WASM build -> BigInt.
      const rc = m.ccall(
        'ks_asm',
        'number',
        ['pointer', 'pointer', 'number', 'pointer', 'pointer', 'pointer'],
        [this.handle, bp, BigInt(baseAddr), ip, sp, cp],
      );
      if (rc !== 0) {
        const errno = m.ccall('ks_errno', 'number', ['pointer'], [this.handle]);
        const msgPtr = m.ccall('ks_strerror', 'number', ['number'], [errno]);
        return { ok: false, error: m.UTF8ToString(msgPtr), errno };
      }
      const insnPtr = m.getValue(ip, '*');
      const size = m.getValue(sp, 'i32');
      const count = m.getValue(cp, 'i32');
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = m.getValue(insnPtr + i, 'i8') & 0xff;
      m.ccall('ks_free', 'void', ['pointer'], [insnPtr]);
      return { ok: true, bytes, count };
    } finally {
      m._free(ip);
      m._free(sp);
      m._free(cp);
      m._free(bp);
    }
  }

  close(): void {
    if (this.closed) return;
    this.m.ccall('ks_close', 'number', ['pointer'], [this.handle]);
    this.closed = true;
  }
}

// stringToUTF8 needs a buffer sized in *bytes*, not JS chars (multibyte chars).
function lengthBytesUTF8(str: string): number {
  return new TextEncoder().encode(str).length;
}
