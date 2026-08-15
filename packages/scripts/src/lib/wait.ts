import net from "node:net";
import { localPort } from "@xitter/config";

export const keycloakBaseUrl = () => `http://localhost:${localPort("keycloak")}`;

async function httpOk(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.ok || res.status === 302 || res.status === 401) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function tcpOpen(port: number, host = "localhost", timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`Port ${host}:${port} never opened`));
        else setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

/** Wait until local dependencies answer (compose gates on healthchecks; this is belt+braces). */
export async function waitForDependencies(): Promise<void> {
  const [keycloakReady] = await Promise.all([
    httpOk(`${keycloakBaseUrl()}/realms/master`, 120_000),
    tcpOpen(localPort("postgres")),
    tcpOpen(localPort("kafka")),
    tcpOpen(localPort("opensearch")),
    tcpOpen(localPort("rustfs")),
  ]);
  if (!keycloakReady) throw new Error("Keycloak never became healthy");
}
