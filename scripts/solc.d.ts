// solc-js ships no types; this is the part the scripts use.
declare module "solc" {
  interface ImportResult {
    contents?: string;
    error?: string;
  }
  const solc: {
    compile(input: string, callbacks?: { import?: (path: string) => ImportResult }): string;
    version(): string;
  };
  export default solc;
}
