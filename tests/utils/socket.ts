export function onceSocketEvent<T = unknown>(
  socket: {
    once: (event: string, handler: (payload: T) => void) => void;
    off?: (event: string, handler: (payload: T) => void) => void;
  },
  event: string
) {
  return new Promise<T>((resolve) => {
    const handler = (payload: T) => {
      socket.off?.(event, handler);
      resolve(payload);
    };

    socket.once(event, handler);
  });
}
