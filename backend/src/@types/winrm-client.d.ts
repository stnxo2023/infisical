declare module "winrm-client" {
  export function runPowershell(
    command: string,
    host: string,
    username: string,
    password: string,
    port: number,
    useHttps?: boolean,
    rejectUnauthorized?: boolean,
    caCert?: string,
    tlsServerName?: string
  ): Promise<string>;

  export function runCommand(
    command: string,
    host: string,
    username: string,
    password: string,
    port: number,
    isPowershell?: boolean,
    useHttps?: boolean,
    rejectUnauthorized?: boolean
  ): Promise<string>;
}
