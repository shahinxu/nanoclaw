import { BiomedWorkflowRunner } from '../src/biomed/runner.ts';
import { CsvTaskLoader } from '../src/biomed/task-loader.ts';

async function main(): Promise<void> {
  const runner = new BiomedWorkflowRunner();
  const loader = new CsvTaskLoader({
    dataDir: '/home/zhx/drug_agent/data_edge_test',
    relationshipType: 'drug_protein_disease',
  });

  const samples = await loader.loadSamples();
  const sample = samples.find((item) => item.sampleIndex === 0);
  if (sample === undefined) {
    throw new Error('sample 0 not found');
  }

  const result = await runner.runSample(sample);
  const arbiter = result.trace.assessments.find((item) => item.role === 'arbiter');
  console.log(JSON.stringify({ decision: result.decision, arbiter }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});