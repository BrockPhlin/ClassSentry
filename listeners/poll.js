import { EventEmitter } from "node:events";

// 轮询 search-trans-result 的监听器：Set 去重、可选基线静默、课程结束检测。
// alertOnBaseline=false（直播监控）：首轮全量历史只入 Set 不告警；
// alertOnBaseline=true（replay 重放）：历史条目全部视为新条目正常告警。
export class PollListener extends EventEmitter {
  constructor({ fetchItems, intervalMs, alertOnBaseline = false }) {
    super();
    this.fetchItems = fetchItems;
    this.intervalMs = intervalMs;
    this.alertOnBaseline = alertOnBaseline;
    this.seen = new Set();
    this.stopped = false;
    this.polling = false;
    this.timer = null;
    this.consecutiveFailures = 0;
    this.failureLimit = 5;
    this.endedEmitted = false;
  }

  start() {
    this.stopped = false;
    // 首轮立即拉取，不等第一个 interval
    this.poll(true).catch(() => {});
    this.timer = setInterval(() => {
      this.poll(false).catch(() => {});
    }, this.intervalMs);
  }

  async poll(baseline) {
    if (this.stopped || this.polling) return;
    this.polling = true;
    let result;
    try {
      result = await this.fetchItems();
      this.consecutiveFailures = 0;
    } catch (e) {
      if (this.stopped) return;
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureLimit) {
        this.emit(
          "error",
          new Error(`连续 ${this.consecutiveFailures} 次轮询失败：${e.message}`)
        );
      } else {
        this.emit(
          "status",
          `轮询失败（${this.consecutiveFailures}/${this.failureLimit}）：${e.message}`
        );
      }
      return;
    } finally {
      this.polling = false;
    }
    if (this.stopped) return;

    const fresh = result.items.filter((frag) => !this.seen.has(frag.key));
    for (const frag of fresh) this.seen.add(frag.key);

    if (baseline && !this.alertOnBaseline) {
      this.emit("status", `基线已记录 ${fresh.length} 条历史转写（不告警）`);
    } else {
      for (const frag of fresh) this.emit("fragment", frag);
    }

    // finished=接口已切换到课后 BeginSec 形态，说明本场转写已到头
    if (result.finished && !this.endedEmitted) {
      this.endedEmitted = true;
      this.stop();
      this.emit("ended");
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
