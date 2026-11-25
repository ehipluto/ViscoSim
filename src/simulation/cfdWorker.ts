import { createWorkerProtocolHandler, WorkerCommand } from './workerProtocol';

const handler = createWorkerProtocolHandler('standard');

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const { response, transferables } = handler.handleMessage(event.data);
  if (response) {
    (self as unknown as { postMessage: (msg: unknown, tx?: Transferable[]) => void }).postMessage(
      response,
      transferables
    );
  }
};
