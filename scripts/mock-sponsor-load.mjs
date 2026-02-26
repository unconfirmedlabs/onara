const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const total = Number(process.env.TOTAL_REQUESTS ?? '20');
const concurrency = Number(process.env.CONCURRENCY ?? '20');

if (!Number.isInteger(total) || total <= 0) {
  throw new Error(`TOTAL_REQUESTS must be a positive integer. Got: ${total}`);
}

if (!Number.isInteger(concurrency) || concurrency <= 0) {
  throw new Error(`CONCURRENCY must be a positive integer. Got: ${concurrency}`);
}

let nextIndex = 0;
const results = [];

async function runOne(index) {
  try {
    const mockRes = await fetch(`${baseUrl}/mock`);
    const mockText = await mockRes.text();
    if (!mockRes.ok) {
      return {
        ok: false,
        index,
        step: 'mock',
        status: mockRes.status,
        body: mockText,
      };
    }

    let payload;
    try {
      payload = JSON.parse(mockText);
    } catch {
      return {
        ok: false,
        index,
        step: 'mock-parse',
        status: mockRes.status,
        body: mockText,
      };
    }

    const sponsorRes = await fetch(`${baseUrl}/sponsor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const sponsorBody = await sponsorRes.text();
    return {
      ok: sponsorRes.ok,
      index,
      step: 'sponsor',
      status: sponsorRes.status,
      body: sponsorBody,
    };
  } catch (error) {
    return {
      ok: false,
      index,
      step: 'network',
      status: 0,
      body: error instanceof Error ? error.message : String(error),
    };
  }
}

async function worker() {
  while (true) {
    const index = nextIndex++;
    if (index >= total) return;
    const result = await runOne(index);
    results.push(result);
    const icon = result.ok ? 'OK ' : 'ERR';
    console.log(`${icon} #${index + 1} status=${result.status} step=${result.step}`);
  }
}

const workers = Array.from(
  { length: Math.min(concurrency, total) },
  () => worker(),
);

await Promise.all(workers);

const successCount = results.filter((r) => r.ok).length;
const failureCount = results.length - successCount;

console.log('\n--- Summary ---');
console.log(`Base URL: ${baseUrl}`);
console.log(`Total: ${total}`);
console.log(`Concurrency: ${Math.min(concurrency, total)}`);
console.log(`Success: ${successCount}`);
console.log(`Failure: ${failureCount}`);

if (failureCount > 0) {
  console.log('\n--- First failures ---');
  for (const failure of results.filter((r) => !r.ok).slice(0, 5)) {
    console.log(
      `#${failure.index + 1} status=${failure.status} step=${failure.step} body=${failure.body}`,
    );
  }
  process.exitCode = 1;
}
