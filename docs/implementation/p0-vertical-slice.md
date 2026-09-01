# P0 构建与静态引导基础合同

更新：2026-08-29。状态：全域反证后待实施。文件名为兼容既有链接保留；P0不再声称已经形成外部纵切。

## 1. P0准确目标

P0只证明唯一authoring事实可以被严格解析、生成并由最小packed MV3静态引导消费：

```text
四份pending authoring registry + 一个固定版本transport descriptor
  -> Zig 0.16 strict configurator
  -> resolved build facts + canonical digests
  -> generated Zig/TypeScript/manifest/CSP projections
  -> MV3 module service worker
  -> packaged Zig/WASM startup self-test
```

它不证明Key鉴权、Agent调用、relay、WebSocket、MV3长连接恢复、operation或浏览器自动化。`system.describe`仍是`key_required`的pending命令；P0只生成并校验其schema/descriptor数据，不建立handler、dispatcher、admin后门或临时无Key route。

## 2. 为什么撤下旧P0网络路线

旧P0同时声称“零外部effect”和“service worker真实尝试loopback WebSocket”，两者冲突。它还在authority、Key、完整role握手、connect deadline、alarms和keepalive之前启动半条transport，不能安全地区分relay、错误服务和不可恢复worker状态。P0的“零网络”准确指零外部/loopback连接；读取当前扩展包内精确`chrome-extension://` seal/WASM资源属于静态引导，不是对外通信。

因此P0明确禁止：

- 创建offscreen document/dedicated worker、WebSocket、timer/alarm retry scheduler或任何native连接。
- 读取/写入`storage.session`或IndexedDB业务状态。
- 申请`storage`、`alarms`、`offscreen`、host、tabs、scripting、userScripts、debugger、nativeMessaging或loopback/external `connect-src`；P0只允许CSP基线`connect-src 'self'`读取包内资源。
- 激活`transport.retry_interval_ms`、loopback bind、transport capability、public Error或Command声明。
- 用fake clock、测试fixture或计划中的文件名冒充runtime consumer。

用户确认的`transport.retry_interval_ms=10000`仍是首个Freedom Point；它在P3真实transport scheduler与反向校验同一变更落地前保持pending。pending表示尚未进入resolved runtime，不是否定其已定默认值。

## 3. 固定工具与执行路线

- Zig编译语义锁定`0.16.0`；本机可执行路径只写入执行证据，不进入项目配置或生成摘要。
- Node `25.2.1`是当前已验证的开发主机版本，不声明为产品runtime或未经测试的最低版本；等真实脚本使用具体Node API后再由兼容测试确定支持范围。
- TypeScript：精确锁定`7.0.2`，无bundler、framework或runtime依赖。
- TypeScript模块解析：`NodeNext`；相对ESM import在源码中使用最终`.js`后缀。
- 根`tsconfig.json`只覆盖P0 background/generated的WebWorker realm。P2 admin UI、P5 content和P6 user-script出现时各建独立TS project/lib组合；不能把DOM与WebWorker globals混进一个全树配置后靠类型冲突碰运气。
- npm缓存位置属于执行主机优化；项目`node_modules`不提交，缓存路径不进入构建事实。
- 当前Codex Desktop执行Zig native build时使用受控launcher并固定`-j1`是本机稳定性措施，不进入产物协议；交叉编译不能替代Windows/Linux真实运行证据。

若工具版本失败，先记录最小复现、诊断是版本/API还是方案错误，再调整；不通过引入bundler或把纯核心悄悄迁回TS绕过。

## 4. P0文件与激活边界

```text
registries/{freedom,commands,errors,capabilities}.registry.json
modules/configurator/
modules/protocol/canonical/
modules/protocol/transport/
modules/protocol/command/
adapters/extension-wasm/
apps/extension/src/background/main.ts
apps/extension/src/generated/
apps/extension/wasm/
apps/extension/manifest.json
apps/extension/artifact.seal.json
generated/
tests/{registry,protocol,wasm,extension}/
build.zig / build.zig.zon / package.json / tsconfig.json
```

不创建`transport-scheduler.ts`、relay、Key、operation、DOM或清洗placeholder。

当前四份registry全部pending、consumer为空。P0源码真实落地后，只有确实被模块入口/manifest/WASM自检消费并能反向验证的基础声明可在**同一变更**改为active；通常只涉及module service worker、bootstrap WebCrypto SHA-256/CSPRNG API availability、packaged WASM及其必要build facts。CSPRNG probe只验证API/长度/编码/异常路径，熵质量属于平台信任边界，不能用样本统计伪造证明。Command permission/schema/declaration、业务Error、IndexedDB/storage.session/alarms和transport仍保持pending。

`active`不等于“写了JSON”：它同时要求source consumer、generated projection、manifest/CSP影响、probe/fixture和反向完整性门。外部route是否开放另有显式字段，不能由active handler暗推。

## 5. 最小manifest

P0实现后的manifest只包含：

- Manifest V3元数据。
- 从版本化Capability/Platform profile descriptor `chromium-full-v1`唯一投影出的`minimum_chrome_version: "138"`；该候选不是随手取当前版本：[官方`userScripts`合同](https://developer.chrome.com/docs/extensions/reference/api/userScripts)显示`execute()`从135提供，而138起使用每扩展Allow User Scripts开关，避免要求用户打开全局Developer Mode。当前只有一个真实profile，所以它不是伪Freedom Point，也不能在manifest另写第二个默认；WebSocket LNA从147起是后续动态capability分支，不反向抬高P0 floor。以后出现第二个已实现profile时再引入build选择点。
- 一个真实存在的module service worker入口。
- 仅为包内WASM所需的extension page CSP token，以及明确的`connect-src 'self'`包内读取边界。

permissions、host_permissions、content scripts、web accessible resources和loopback/external connect source均为空/缺省。startup self-test只读取包内生成常量与WASM bytes；允许对精确`chrome.runtime.getURL(...)`包内资源做只读加载，不允许`http:|https:|ws:|wss:`、任意origin、loopback、浏览器页面或持久状态访问。CSP反向门要求P0的`connect-src`闭合集合恰好只有`'self'`，不能因为Chrome默认CSP对连接较宽就依赖源码自律。

seal在WASM可被信任前就要解析和hash，因此P0必须有不依赖WASM的generated TypeScript bounded strict JSON scanner，并用service-worker WebCrypto通过SHA-256 known-answer后验证清单。TS scanner与Zig native/WASM canonical parser共享golden/negative corpus，保留lossless number token直到schema裁决；普通`JSON.parse`既不能检测decoded duplicate key，也会提前把number压成IEEE-754，不能单独充当安全门。WebCrypto失败是bootstrap fatal capability缺口，不能先加载未验证WASM去“修复”验证器。

## 6. 摘要与生成

configurator必须从严格UTF-8 JSON与固定版本化descriptors生成canonical resolved snapshot：未知/重复字段、尾随值、非规范顺序、悬空permission/schema/capability/error引用、pending被消费及active无双向consumer全部失败。当前Freedom authoring全pending，只能产生catalog解析结果，**不能**先产生冒充resolved runtime/build的point投影；P0实现提交必须先为strict scanner真实使用的protocol hard limits及`build.extension.maximum_wasm_linear_memory_bytes`补齐声明、consumer、投影、fixture和反向门，并在同一变更把它们激活，之后才允许emit引用其值的摘要。WASM maximum必须真实进入最终module/imported Memory限制，只有生成常量不算consumer。固定`chromium-full-v1` descriptor可参与build facts，但不是editable point。

- `registryCatalogDigest`覆盖四份authoring registry规范内容，包括pending声明。
- `transportCompatibilityDigest`覆盖版本化transport descriptor以及descriptor显式引用、会改变两端wire parse/limit语义的**active resolved build-point**值；pending point完全省略且其default不可读取。若descriptor声明某point为required ref而该point未active，生成失败，不为“先拿确定digest”降级。endpoint位置和component私有打包事实不进入该兼容域。`commandProtocolDigest`覆盖fixed common business-message descriptor与`agent_relay`可见command wire投影；P0 Agent命令集为空仍可由common descriptor生成确定值，admin-only方法永不混入。
- `resolvedBuildArtifactDigest`覆盖当前extension组件的resolved build facts与非自引用生成物清单；以后Windows/Linux companion各有自己的组件digest。
- Zig descriptor、TypeScript常量、manifest/CSP和golden fixtures全由同一resolved model发射。

payload不内嵌自己的artifact digest；生成器最后写不参与自身hash的`artifact.seal.json`。构建/打包门拥有目录枚举能力，必须证明staging root除seal外的文件集合与清单完全相等并拒绝多余文件。module worker没有CRX目录枚举API，只能验证seal schema及清单中每个声明文件的存在/长度/digest；该步成功只置`artifactIntegrityReady`，不能声称运行时发现未列出的额外文件。WASM instantiate/ABI/self-test是随后独立的startup capability probe：成功将该capability加入`effectiveGlobalCapabilityIds`，失败则记录typed unavailable fact，但不阻断generated TypeScript诊断描述器启动。P0发布验收仍要求测试artifact的WASM probe成功；这与“异常运行时仍能在P3后诊断该capability缺口”不矛盾。生成路径统一为portable ASCII、产物根相对POSIX `/`形式并应用上一节的collision/reserved-name门；文本统一UTF-8无BOM/LF。本机绝对路径、cache、构建时间和目录枚举顺序不得影响digest。Windows/Linux native target triple作为显式build fact分别证明，不能用路径分隔差异制造假不一致。

运行时代码不解析raw registry，不维护第二份default或schema表。删除generated输出后必须可完全重建；手改生成物必须被seal门发现。

## 7. P0验收门

1. 四份JSON与版本化transport descriptor严格解析、stable ID/字段排序、引用闭包、pending/active及profile变更正负例全部通过。
2. 在P0必要build points已经真实active之后，canonical encoding与实际生成的四个digest domain（registry catalog、transport compatibility、Agent command protocol、当前component artifact）的golden/negative fixtures在native Zig和WASM逐字节一致；在此之前只允许验证catalog parser，不记录四摘要已产生。runtime facts与operation intent/plan摘要到各自有真实consumer的阶段再验收，不用未实现fixture凑“六个”。
3. generated TS strict scanner、native Zig与WASM先对相同duplicate-key/surrogate/limit/canonical corpus逐字节一致；service-worker WebCrypto SHA-256 known-answer先于seal验证通过。WASM fixture再过`WebAssembly.validate`和alloc/free或arena ABI边界测试；build verifier解析最终binary/import descriptor并证明线性内存initial/maximum与resolved 64 KiB page值一致，`memory.grow`到边界成功、越界失败且不会改旧memory。packed worker还必须真正instantiate模块、核对ABI/version并调用一个有确定返回值的self-test export。仅validate字节语法或TS侧写了limit不算capability active。
4. `tsc`以NodeNext完成无bundler编译；所有相对ESM import使用`.js`后缀，extension source不得import Node builtin、bare runtime package或remote URL。包内路径闭合为portable ASCII相对路径并拒绝大小写折叠碰撞、Windows保留名、尾点/空格、控制字符、`.`/`..`、反斜杠、symlink/junction，避免同一seal在不同解包语义下指向不同文件。
5. 从空generated目录连续重建两次，路径清单、内容和digest逐字节一致。
6. 修改任一payload byte、缺失文件、伪造seal字段或把seal误纳入自身hash均被runtime/build门拒绝；多出未声明文件由拥有目录枚举能力的build/package verifier拒绝，不伪造worker能力。
7. Chrome/Chromium 138+ packed profile能加载module worker并完成seal + WASM instantiate/ABI/self-test；manifest的minimum version从build profile反向一致，没有storage/alarms/offscreen/host/debug/native/content权限，extension-page CSP的`connect-src`只有`'self'`而无loopback/external来源。
8. 负向spy证明不存在外部/loopback网络、storage、tabs、content messaging或browser effect；包内seal/WASM读取单独按精确scheme/path allowlist验证，不能被“零网络”误杀或扩成任意fetch。
9. 当前registry中不存在active无consumer或非空伪consumer。

P0通过后只允许进入P1 authority骨架；第一条真实外部命令要等P2 Key完成后，在P3与relay和完整transport一起闭环。
