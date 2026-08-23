import net from 'node:net';

/** True when something is listening on the port (liveness probe, not HTTP). */
export async function checkPort(port: number, host = 'localhost'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    // Neither event within a second counts as down.
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1_000).unref();
  });
}
