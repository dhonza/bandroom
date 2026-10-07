import type { ClientConfig } from "@bandroom/shared";
import { createContext, useContext } from "react";

export const ClientConfigContext = createContext<ClientConfig | null>(null);

export function useClientConfig(): ClientConfig {
  const config = useContext(ClientConfigContext);
  if (config === null) throw new Error("ClientConfigContext is missing");
  return config;
}
