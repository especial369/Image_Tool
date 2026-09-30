/**
 * 引擎算法自测（纯逻辑模块，Node 直接运行，不依赖微信环境）。
 * 运行方式：npm test（先由 tsc 编译 qualitySearch/queue 到 .test-build/，再执行本文件）。
 * 模拟导出器基于「体积 ≈ 底数 ×(0.25+0.75·q)×scale²」的线性化 JPEG 模型。
 */
const assert = require('assert');
const { searchForTargetBytes } = require('../.test-build/engine/qualitySearch.js');
const { runSerial } = require('../.test-build/engine/queue.js');

const KB = 1024;
const MB = 1024 * 1024;
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓', name);
  } catch (e) {
    failed += 1;
    console.error('  ✗', name, '\n    ', e.message);
  }
}

async function main() {
  console.log('qualitySearch:');

  await test('估算定位+收敛命中 100KB 目标（≤10 轮）', async () => {
    let n = 0;
    const cleaned = new Set();
    const res = await searchForTargetBytes(
      {
        exportAt: async (q, s) => {
          n += 1;
          const bytes = Math.round(MB * (0.25 + 0.75 * q) * s * s);
          return { path: `tmp-${n}`, bytes, w: 413, h: 579 };
        },
        cleanup: (p) => cleaned.add(p),
      },
      { targetBytes: 100 * KB, sourceBytes: MB, maxIterations: 10 }
    );
    assert.strictEqual(res.targetMet, true, `targetMet, best=${res.bestBytes}`);
    assert.ok(res.bestBytes <= 100 * KB * 1.1, `bestBytes=${res.bestBytes} 超出容差`);
    assert.ok(res.iterations <= 10, `iterations=${res.iterations}`);
    assert.strictEqual(cleaned.size, res.iterations - 1, '非最优中间产物应全部清理');
  });

  await test('限定尺寸（fixedDims）：scale 锁 1、禁止降采样，质量到底如实返回未达标', async () => {
    const res = await searchForTargetBytes(
      {
        exportAt: async (q, s) => ({
          path: `p${Math.random()}`,
          bytes: Math.round(MB * (0.25 + 0.75 * q)), // 忽略 scale
          w: 413,
          h: 579,
        }),
        cleanup: () => undefined,
      },
      { targetBytes: 10 * KB, sourceBytes: MB, fixedDims: true }
    );
    assert.strictEqual(res.scale, 1, '限定尺寸下 scale 必须为 1');
    assert.strictEqual(res.targetMet, false, '287KB 压不到 10KB，应如实标记未达标');
    assert.ok(res.iterations <= 6, `iterations=${res.iterations}`);
  });

  await test('无进展提前退出：导出器恒定 500KB 时不做无谓重试', async () => {
    let n = 0;
    const res = await searchForTargetBytes(
      {
        exportAt: async () => {
          n += 1;
          return { path: `p${n}`, bytes: 500 * KB, w: 1, h: 1 };
        },
        cleanup: () => undefined,
      },
      { targetBytes: 100 * KB, sourceBytes: MB, maxIterations: 8 }
    );
    assert.strictEqual(res.targetMet, false);
    assert.ok(n < 8, `应在质量到底后提前退出，实际导出 ${n} 次`);
  });

  await test('首轮即达标：立即返回，iteration=1', async () => {
    const res = await searchForTargetBytes(
      {
        exportAt: async () => ({ path: 'p', bytes: 90 * KB, w: 1, h: 1 }),
        cleanup: () => undefined,
      },
      { targetBytes: 100 * KB, sourceBytes: MB }
    );
    assert.strictEqual(res.targetMet, true);
    assert.strictEqual(res.iterations, 1);
    assert.strictEqual(res.bestPath, 'p');
  });

  console.log('queue:');
  await test('串行队列：单张抛错不阻塞，顺序与进度回调正确', async () => {
    const order = [];
    const results = await runSerial(
      ['a', 'b', 'c'],
      async (p) => {
        if (p === 'b') throw new Error('boom');
        return { inputPath: p, ok: true };
      },
      { onItemDone: (done) => order.push(done) }
    );
    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[1].ok, false, '失败项应返回 ok=false');
    assert.match(results[1].error || '', /boom/);
    assert.ok(results[0].ok && results[2].ok, '失败不应阻塞后续');
    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
