import { runBillingMaintenance } from '../src/lib/billingMaintenance';

async function main() {
  const summary = await runBillingMaintenance({ source: 'manual' });
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error('Failed to run billing maintenance:', error);
    process.exitCode = 1;
  });
