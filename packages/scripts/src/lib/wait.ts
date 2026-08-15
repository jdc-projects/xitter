import net from "node:net";
import { localPort } from "@xitter/config";
import { waitForHealthy } from "@xitter/testing";

export const keycloakBaseUrl = () => `http://localhost:${localPort("keycloak")}`;

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

/** Wait until local dependencies answer (compose already gates on healthchecks; this is belt+braces). */
export async function waitForDependencies(): Promise<void> {
  await Promise.all([
    tcpOpen(localPort("postgres")),
    tcpOpen(localPort("kafka")),
    tcpOpen(localPort("opensearch")),
    tcpOpen(localPort("rustfs")),
    waitForHealthy(`${keycloakBaseUrl()}/realms/master`, 120_000),
  ]);
}
