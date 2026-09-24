// write-file-atomic 8 ships no type declarations; this covers the calls Taskyard makes.
declare module 'write-file-atomic' {
  interface Options {
    encoding?: BufferEncoding
    mode?: number
    chown?: { uid: number; gid: number }
    /** Defaults to true: the temp file is fsync'ed before the rename. */
    fsync?: boolean
    tmpfileCreated?: (tmpfile: string) => void | Promise<void>
  }

  /** Writes `data` to a temp file beside `filename`, then renames it over `filename`. */
  function writeFileAtomic(
    filename: string,
    data: string | NodeJS.ArrayBufferView,
    options?: Options | BufferEncoding
  ): Promise<void>

  namespace writeFileAtomic {
    function sync(
      filename: string,
      data: string | NodeJS.ArrayBufferView,
      options?: Options | BufferEncoding
    ): void
  }

  export = writeFileAtomic
}
