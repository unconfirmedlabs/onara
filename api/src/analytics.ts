interface AnalyticsEngineDataset {
  writeDataPoint(event: {
    indexes?: string[]
    blobs?: string[]
    doubles?: number[]
  }): void
}

export interface AnalyticsParams {
  dataset: AnalyticsEngineDataset | undefined
  sender: string
  epoch: string
  policyName: string
  digest: string
  rpcNode: string
  cf: Record<string, string> | undefined
  userAgent: string
  ipHash: string
  success: boolean
  durationMs: number
  gasUsed: { computationCost?: string | number; storageCost?: string | number; storageRebate?: string | number } | undefined
  gasBudget: number
  numMoveCalls: number
}

export function writeAnalytics(params: AnalyticsParams): void {
  params.dataset?.writeDataPoint({
    indexes: [params.sender],
    blobs: [
      params.sender,              // blob1:  sender
      params.epoch,               // blob2:  epoch
      params.policyName,          // blob3:  policy name
      params.digest,              // blob4:  tx digest
      params.rpcNode,             // blob5:  RPC node
      params.cf?.colo ?? '',      // blob6:  colo
      params.cf?.country ?? '',   // blob7:  country
      params.cf?.city ?? '',      // blob8:  city
      params.cf?.continent ?? '', // blob9:  continent
      params.userAgent,           // blob10: user agent
      params.ipHash,              // blob11: ip hash (sha-256)
    ],
    doubles: [
      params.success ? 1.0 : 0.0,                    // double1: success
      1.0,                                             // double2: request count
      params.durationMs,                               // double3: execution duration (ms)
      Number(params.gasUsed?.computationCost ?? 0),    // double4: computation cost
      Number(params.gasUsed?.storageCost ?? 0),        // double5: storage cost
      Number(params.gasUsed?.storageRebate ?? 0),      // double6: storage rebate
      params.gasBudget,                                // double7: gas budget
      params.numMoveCalls,                             // double8: num move calls
    ],
  })
}
