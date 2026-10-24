// 受限解析子进程的 RSS 看门狗探针：只分配**堆外** Buffer（与 pdfjs 解 FlateDecode
// 炸弹同类的内存），V8 的 --max-old-space-size 管不到，只有父进程的 RSS 看门狗能停住它。
for await (const chunk of process.stdin) {
  // 与生产 worker 相同：先读完 stdin 协议。
  void chunk;
}

const retained = [];
for (;;) {
  // Buffer.alloc 会真正写满页面，RSS 随之增长。
  retained.push(Buffer.alloc(8 * 1024 * 1024, 1));
  await new Promise((resolve) => setTimeout(resolve, 20));
}
