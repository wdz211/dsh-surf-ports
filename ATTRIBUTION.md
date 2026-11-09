# Attribution

本仓库包含以下第三方代码，均按 MIT 许可使用，原文版权归原作者所有。

## surfcore

- 上游：<https://github.com/Mieksido/surfcore>
- 许可：MIT License
- 版权：`Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors`

  出处：上游随代码分发的许可声明原文（本仓库创建时从源目录已有声明中用命令取出，未改写）：
  `许可：**MIT License**，Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors`

- 搬运内容：`src/` 下 8 个文件**原样搬运、未改一字**（SHA-256 与上游逐字节一致）：

  | 文件 | 用途 |
  | --- | --- |
  | `src/model-prices.js` | 价目表、峰谷判定、usage → 人民币折算 |
  | `src/token-ledger.js` | token 采样折叠与按桶聚合 |
  | `src/token-budget.js` | 每日额度：人民币/token 双单位、80% 提醒、100% 拦截 |
  | `src/slang-learner.js` | 黑话库 CRUD、抽取/研究提示词、注入文本 |
  | `src/md-to-plain.js` | Markdown → 纯文本（slang 的依赖） |
  | `src/sticker-semantics.js` | 表情情绪/内容/关键词打分（0.46 / 0.38 / 0.16） |
  | `src/dsh-port.js` | 探测「当前那只 DSH」监听的回环端口 |
  | `src/config-stamps.js` | 配置文件版本戳（mtime+size），防整份回写覆盖别人的修改 |

- 搬运日期：2026-10-31
- 我们写的部分：`index.js`（工具外壳、参数/输出 schema、render、nekowhale 元数据 → 表情评分入参的映射、数据根与落盘策略）、`test/`、`README.md`、本文件、`LICENSE`、CI 配置。

### 为什么原样搬

这四件能力里的判断与折算（表情权重、峰谷时段、节假日表、额度语义、黑话库容量与去重策略）
都是上游在真实流量上校准过的。重写等于把这些经验丢掉、只剩想象，所以上游纯逻辑一字不动，
差异全部落在 `index.js`；好处是上游以后修 bug 时还能逐行 diff。

### MIT 许可原文

```
MIT License

Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
