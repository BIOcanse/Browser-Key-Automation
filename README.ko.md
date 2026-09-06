# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | 한국어 | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

**평소 쓰던 브라우저를 Agent와 함께.**

로그인된 Chromium 탭에서 페이지 읽기, 작업, 결과 저장까지 이어집니다. 일반 명령은 확장 권한을 사용하므로 별도 자동화 브라우저, 자동 디버거 연결, 확장 자체의 매번 확인이 없습니다. 브라우저의 권한 확인은 유지됩니다.

## 주요 장점

- **필요한 부분만 읽기.** 캐시된 작업 트리는 전체 구조를 유지하면서 요청한 가지를 펼칩니다. 문서가 바뀌지 않으면 탭을 돌아와도 펼침 상태가 남습니다. 깊이·구간·하위 트리는 일회성 보기 선택입니다.
- **탭을 넘나드는 작업.** 명시적 참조, Key별 직렬 실행, 탭·창·전체 점유로 협업 충돌을 줄입니다.
- **결과를 바로 저장.** MHTML, 페이지·Canvas 요소 이미지, 리소스 전송, 로컬 서버 없는 HTML 데모.
- **입력 방식 선택.** DOM, Windows 실제 입력, 독립적인 가상 마우스·키보드, 필요할 때의 CDP.
- **결과 확인.** `ensure.run`은 조건, 제한된 준비, 동작, 관찰 가능한 목표를 묶습니다. 결과를 모르면 모른다고 반환하며 무조건 재실행하지 않습니다.

## 시작하기

> 새 설치에는 동일한 **공개 Root 체험 Key**가 생성되며 값은 Agent skill에 있습니다. 개인 브라우저에서는 비공개 Key를 만들고 클라이언트를 전환한 뒤 체험 Key를 폐기하세요. 새 Key 생성만으로는 비활성화되지 않습니다. 업데이트는 이를 추가하거나 복원하지 않습니다.

1. Chromium **138+**, Windows 또는 Linux x64, CLI용 **Node.js 20+**가 필요합니다. [최신 릴리스](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest)의 두 ZIP을 각각 압축 해제하세요.

   - `browser-key-automation-extension-v0.0.0.5.zip`
   - `browser-key-automation-local-app-v0.0.0.5.zip`

2. `chrome://extensions` 개발자 모드에서 `manifest.json`이 있는 폴더를 로드합니다. 도구 모음에서 Key를 관리하세요. `js.execute`에는 **Allow User Scripts**가 필요하지만 DOM과 트리에는 필요하지 않습니다.

3. 아래 명령으로 App을 실행하세요. Windows에서는 `virtual-mouse-hook.dll`을 실행 파일 옆에 둡니다. 연결되지 않으면 약 10초마다 `127.0.0.1:32189`에 재시도합니다.

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

4. Agent에 동봉된 `skill/browser-key-automation/SKILL.md`를 설치하거나 로드하세요. 인스턴스를 확인해 브라우저를 선택하고 비공개 Key를 명령행 인수 대신 `BKA_API_KEY` 환경 변수로 전달하세요. 모든 인스턴스에 Key를 시험하지 마세요.

```text
node client/browser-key-cli.mjs instances
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

## 페이지에서 결과까지

`system.describe`로 유효 권한을 확인하고 정확한 인수는 [명령 레지스트리](dev/skills/browser-key-automation/references/commands.registry.json)를 참조하세요.

| | API / CLI |
| --- | --- |
| 탐색·선택·펼치기 | `tabs.list` → `page.tree.open` → `page.tree.find` / `page.tree.expand.v2` → `page.tree.view.get` |
| 페이지 조건 대기 | `page.wait` · `ensure.run` |
| 페이지 저장·화면·요소 이미지 | `page-save` · `page-shot` · `element-shot` |
| HTML 업로드와 표시 | `demo-open` |
| DOM·실제 클릭 | `dom.click` · `dom.click.real` |
| 텍스트·단축키·키 해제 | `keyboard.type` · `keyboard.typeHuman` · `keyboard.press` · `keyboard.reset` |
| 가상 마우스·키보드 | `virtualMouse.*` · `virtualKeyboard.*` |
| 입력 대상 측정 | `input.calibrate` |
| 명시적 CDP 연결 | `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach` |

```text
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
node client/browser-key-cli.mjs demo-open ./demo.html
```

## Key와 입력의 경계

- Root는 모든 활성 권한을 가집니다. Regular Key는 펼칠 수 있는 권한 그룹, 만료, 다시 보기, 비활성화, 폐기를 지원합니다. JavaScript와 실제 입력 권한은 독립적입니다. Key는 결제·게시·삭제에 대한 사용자 동의를 대신하지 않습니다.
- 가상 입력 상태는 Key에 연결되어 탭을 넘어 유지되며 대상 창 전체 점유가 필요합니다. 일반 가상 입력 동작에는 유효한 `input.calibrate`가 필요하고 `ensure.run`은 필요할 때 갱신합니다. 실제 입력은 전경 창이 필요하며 가상 입력은 물리 커서를 움직이지 않습니다.
- Windows는 네이티브 입력을 제공합니다. Linux는 현재 브라우저 중계와 파일 처리만 제공합니다. 최소화 창은 지원하지 않습니다. 첫 보정에는 측정 가능한 페이지가 필요하며 가려진 창의 보정 재사용에는 조건이 있습니다. 다중 창 첫 보정과 완전한 HTML5/OLE 드롭에는 미해결 사례가 있습니다.
- 요소 이미지는 보이는 뷰포트와 지원하는 모양 마스크만 사용합니다. Chrome의 제한 페이지·사이트 권한·사용자 스크립트 설정과 `debugger.attach` 경고는 유지됩니다. 합성 이벤트와 가상 메시지는 모든 입력 제한을 우회하지 못합니다.

## 적합한 용도

기존 개인 브라우저 연결, 선택적 트리, 일관된 작업·파일 흐름에 집중합니다. 테스트 프레임워크나 DevTools 전체를 대체하지 않습니다.

| | |
| --- | --- |
| [Playwright](https://playwright.dev/docs/intro) · [Selenium](https://www.selenium.dev/documentation/overview/) | 크로스 브라우저 테스트·CI |
| [Puppeteer](https://pptr.dev/) | 프로그래밍 자동화 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | 접근성 스냅샷 기반 Agent 도구 |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | 심층 브라우저 진단 |
| [Browser MCP](https://browsermcp.io/) · [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | 기존 브라우저 MCP 도구 |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | 브라우저 내 Agent UI |

## 가이드와 유지 관리

[Agent skill](dev/skills/browser-key-automation/SKILL.md) · [Operation tree](dev/skills/browser-key-automation/references/operation-tree.md) · [Ensure](dev/skills/browser-key-automation/references/ensure-workflows.md) · [Virtual input](dev/skills/browser-key-automation/references/virtual-mouse.md) · [Capture & CDP](dev/skills/browser-key-automation/references/debugger-and-element-capture.md)

확장 UI는 20개 언어, README는 10개 언어 버전입니다. [개인정보](PRIVACY.md) · [개발 구조](dev/README.md). 작성자가 유지 관리하며 외부 기여와 Pull Request는 받지 않습니다.
