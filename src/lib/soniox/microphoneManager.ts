// src/lib/soniox/microphoneManager.ts
// 麦克风管理 + 热切换（独立于 Soniox session）

export class MicrophoneManager {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: { blob: Blob; startTime: number }[] = [];
  private currentDeviceId: string | null = null;
  private sessionStartTime: number = 0;
  private globalTimeOffset: number = 0;
  private stream: MediaStream | null = null;

  /** 获取可用麦克风列表 */
  async getDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  /** 开始本地录音（独立于 Soniox） */
  async startLocalRecording(deviceId: string) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } },
    });

    this.mediaRecorder = new MediaRecorder(this.stream, {
      mimeType: 'audio/webm;codecs=opus',
    });

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.audioChunks.push({ blob: e.data, startTime: Date.now() });
      }
    };

    this.mediaRecorder.start(1000); // 每秒一个 chunk
    this.currentDeviceId = deviceId;
    this.sessionStartTime = Date.now();
  }

  /** 热切换麦克风 — 返回新的时间偏移供 TokenProcessor 使用 */
  async hotSwapMicrophone(newDeviceId: string): Promise<number> {
    // 1. 记录当前时间偏移
    this.globalTimeOffset = Date.now() - this.sessionStartTime;

    // 2. 停止当前本地录音
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.stopStream();

    // 3. 用新麦克风启动本地录音
    await this.startLocalRecording(newDeviceId);

    return this.globalTimeOffset;
  }

  /** 获取当前时间偏移 */
  get currentTimeOffset(): number {
    return this.globalTimeOffset;
  }

  /** 获取当前设备 ID */
  get deviceId(): string | null {
    return this.currentDeviceId;
  }

  /** 获取当前 MediaStream（供 Soniox 使用） */
  get currentStream(): MediaStream | null {
    return this.stream;
  }

  /** 导出完整录音（拼接所有 chunks） */
  async exportFullRecording(): Promise<Blob> {
    return new Blob(
      this.audioChunks.map((c) => c.blob),
      { type: 'audio/webm' }
    );
  }

  /** 停止本地录音并释放资源 */
  stop() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.stopStream();
  }

  private stopStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  /** 重置 */
  reset() {
    this.stop();
    this.audioChunks = [];
    this.currentDeviceId = null;
    this.sessionStartTime = 0;
    this.globalTimeOffset = 0;
  }
}
