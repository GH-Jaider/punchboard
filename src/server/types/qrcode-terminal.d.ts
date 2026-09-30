// qrcode-terminal ships without type definitions.
declare module "qrcode-terminal" {
  interface Options { small?: boolean }
  const qrcodeTerminal: {
    generate(text: string, options: Options, callback: (code: string) => void): void
    generate(text: string, callback?: (code: string) => void): void
  }
  export default qrcodeTerminal
}
