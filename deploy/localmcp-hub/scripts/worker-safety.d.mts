export function isIsolatedPartialHubWorker(
  worker: Record<string, any>,
  existingRoute: unknown,
  now?: number
): boolean;

export function renderDeployWranglerConfig(
  template: string,
  options: {
    accountId: string;
    hubDomain: string;
    zoneName: string;
    workerRecords?: Array<{ name?: string }>;
    proxyWorkerName?: string;
  }
): {
  configText: string;
  proxyServiceBound: boolean;
  proxyWorkerName: string | null;
};
