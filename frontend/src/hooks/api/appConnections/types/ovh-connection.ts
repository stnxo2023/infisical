import { AppConnection } from "@app/hooks/api/appConnections/enums";
import { TRootAppConnection } from "@app/hooks/api/appConnections/types/root-connection";

export enum OVHConnectionMethod {
  Pkcs12Certificate = "pkcs12-certificate"
}

export type TOvhConnection = TRootAppConnection & { app: AppConnection.OVH } & {
  method: OVHConnectionMethod.Pkcs12Certificate;
  credentials: {
    pkcs12Certificate: string;
    pkcs12Passphrase?: string;
    okmsDomain: string;
    okmsId: string;
  };
};
