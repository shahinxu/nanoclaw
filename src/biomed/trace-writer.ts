import { SampleTraceRecord } from './types.js';

export interface TraceWriter {
  writeTrace(trace: SampleTraceRecord): Promise<void>;
}

export class NoopTraceWriter implements TraceWriter {
  async writeTrace(_trace: SampleTraceRecord): Promise<void> {
    return;
  }
}