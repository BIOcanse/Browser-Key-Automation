# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | 한국어 | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation은 지금 사용 중인 Chromium 브라우저를 신뢰하는 Agent와 자동화 프로그램을 위한 Key 범위 제어면으로 바꿉니다. 확장 프로그램을 한 번 설치하고 Key를 만들면, 권한 있는 클라이언트가 별도 자동화 브라우저를 띄우지 않고 기존 로그인 탭 사이를 오가며 작업할 수 있습니다.

기본 경로는 일반 확장 API를 사용하며 CDP, WebDriver, remote-debugging 스위치 또는 `chrome.debugger`를 사용하지 않습니다. 설치, 사이트 접근, 한 번 필요한 **Allow User Scripts** 설정은 계속 Chromium이 담당합니다. 이 설정을 마친 뒤 일상 브라우저 명령은 디버거를 연결하지 않으며 Chrome의 디버깅 연결 확인이나 경고 막대도 표시하지 않습니다.

## Browser Key Automation을 선택하는 이유

- **눈앞의 브라우저를 그대로 제어합니다.** 실제 로그인 상태, 쿠키, 확장 프로그램, 사람이 도달한 페이지 상태를 유지하면서 언제든 탭을 나열·생성·선택·이동·새로고침·닫을 수 있습니다.
- **전체 페이지를 Agent 크기의 깨끗한 보기로 만듭니다.** 캐시된 canonical 작업 트리는 전체 구조를 보존하면서 요청한 가지뿐만 펼칩니다. 문서가 바뀔 때까지 Key별 펼침 상태를 유지하고, 깊이·범위·하위 트리의 일회성 보기는 캐시 상태를 바꾸지 않습니다.
- **열린 디버깅 엔드포인트 대신 Key로 신뢰 범위를 정합니다.** Root/Regular Key에는 명시적 권한, 만료, 재표시, 비활성화, 폐기 제어가 있습니다. 같은 Key의 호출은 직렬화되고 서로 다른 Key는 독립적으로 일할 수 있습니다.
- **접미사 하나로 네이티브 클릭을 사용합니다.** Windows의 `dom.click.real`은 확장이 관찰한 요소 좌표와 로컬 App을 결합해 페이지가 합성 DOM 활성화를 거부할 때 OS 수준 왼쪽 클릭을 보냅니다. 대상은 여전히 살아 있고 보이며 활성화되어 있고 가려지지 않아야 합니다.
- **파일을 일급 기능으로 취급합니다.** MHTML 저장, 보이는 viewport 캡처, 리소스의 제한된 Artifact 변환과 디스크 저장, 자체 포함 HTML 업로드, 로컬 Web 서버 없는 브라우저 데모 열기를 바로 수행합니다.
- **신뢰하는 여러 클라이언트가 협력할 수 있습니다.** Key가 탭 또는 전역을 점유해 오염 상태를 막고, 다른 권한 있는 Key는 먼저 기존 점유를 명시적으로 해제한 뒤 획득합니다.

### 워크플로 비교

연결 모델은 2026-09-01 기준으로 확인했습니다. 이 표는 이론적 기능 한계가 아니라 일반 사용 경로를 비교합니다.

| 방식 | 기존 로그인 Chromium | 일반 제어 경로 | 가장 적합한 용도 |
| --- | --- | --- | --- |
| **Browser Key Automation** | 가능, 권한 있는 탭을 자유롭게 횡단 | 일반 확장 API + Key 인증. 로컬 App은 라우팅, 파일, 선택적 `.real` 클릭 추가 | 디버거 연결 없는 장기 Agent 제어, 선택형 캐시 트리, 통합 파일 흐름 |
| [Playwright](https://playwright.dev/docs/api/class-browsertype), [Puppeteer](https://pptr.dev/guides/browser-management), [Selenium](https://www.selenium.dev/documentation/overview/) | 일반 경로는 자동화 세션을 만들지만 기존 Chromium 연결 경로도 제공 | Playwright/CDP, Puppeteer/CDP 또는 WebDriver | 결정적 테스트, 크로스 브라우저 검증, CI, 성숙한 locator 및 디버깅 생태계 |
| [Playwright MCP 확장](https://github.com/microsoft/playwright/tree/main/packages/extension#readme) | 가능. profile token으로 자체 후속 연결 승인을 생략 가능 | Chrome `debugger` 권한을 선언한 확장을 통해 Playwright 중계 | 선택한 기존 탭에서 Playwright action과 accessibility snapshot 사용 |
| [Chrome DevTools MCP](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) | remote debugging을 켜거나 디버깅 엔드포인트를 노출한 뒤 가능 | DevTools/CDP. Chrome auto-connect는 디버깅 세션마다 사용자 허용 요청 | Console, Network, Performance, memory 등 깊은 DevTools 진단 |
| [Browser MCP](https://browsermcp.io/) | 사용자가 현재 탭을 연결한 뒤 가능 | 확장 + 로컬 MCP, 명시적으로 연결한 작업 탭을 대상으로 함 | 선택한 기존 탭 하나를 위한 간결한 MCP 표면 |
| [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | 가능, 탭 횡단 | 확장 + native-messaging bridge. manifest가 일반 권한 외에 `debugger` 요청 | 폭넓은 크로스 탭 MCP, 네트워크 캡처, 다운로드, 파일 업로드 |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | 가능 | Puppeteer/CDP 기반 통합 브라우저 Agent, 사용자가 LLM provider Key 제공 | provider-neutral 제어면이 아닌 통합 multi-Agent UI |

Browser Key Automation은 Playwright/Selenium 테스트 스위트나 깊은 DevTools 진단을 대체하지 않습니다. 사람이 쓰는 브라우저를 낮은 마찰과 명시적 권한으로 제어하고, Agent가 실제 작업을 마칠 만큼 깨끗한 구조와 파일 기능을 제공하는 별도 역할입니다.

> 개발 상태: 현재 unpacked 개발 빌드는 Chrome/Chromium 138 이상을 대상으로 합니다. Chrome 웹 스토어 릴리스가 아닙니다. Store listing은 준비 중이며, 완료 전에는 [GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest)를 사용하십시오. 각 Release에는 `browser-key-automation-extension-v0.0.0.1.zip`과 `browser-key-automation-local-app-v0.0.0.1.zip`, 정확히 두 개의 다운로드만 있습니다.

## 주요 기능

- 로컬 관리 페이지에서 Root/Regular Key를 생성하고, 다시 표시하고, 복사하고, 업데이트하고, 비활성화하고, 폐기할 수 있습니다. 저장된 전체 Key는 일회성 표시가 아니라 나중에도 다시 볼 수 있습니다.
- 원시 브라우저 ID 대신 현재 런타임에 묶인 `TabRef`, `DocumentRef`, `NodeRef`, `TreeRef`, `ArtifactRef`를 사용합니다.
- 캐시된 페이지 작업 트리를 탐색합니다. 펼침 상태는 Key별로 보관되며, 문서가 새로고침되거나 교체되기 전까지 다른 페이지로 이동했다 돌아와도 유지됩니다.
- 트리를 펼치지 않고 노드를 찾고, 깊이·동일 부모 범위·하위 트리의 일회성 보기를 얻으며, 제한된 live DOM을 읽고 노드를 설명하고 DOM 작업을 실행합니다.
- Chromium의 **Allow User Scripts**를 켜면 명시적인 `USER_SCRIPT` 또는 `MAIN` world에서 JavaScript를 실행합니다.
- 탐색, `interactive`, `complete`, DOM 또는 텍스트 조건을 기다립니다.
- 현재 페이지를 MHTML로 저장하고, 검증된 뷰포트 이미지를 캡처하고, 제한된 Artifact를 전송하고, 로컬 HTTP 서버 없이 자체 포함 HTML 데모를 엽니다.
- `dom.click.real`로 명시적인 Windows 네이티브 왼쪽 클릭을 보냅니다. 일반 `dom.click`과 독립된 권한입니다.
- Key가 탭 또는 전역 범위를 점유할 수 있습니다. 다른 권한 있는 Key는 먼저 기존 점유를 명시적으로 해제한 뒤 획득해야 합니다.

정확한 메서드, schema, 권한, 오류의 기준은 Command Registry입니다. `system.describe`는 활성 빌드와 호출 Key의 실제 권한을 반환합니다.

## 빠른 시작

### 요구 사항

- Chrome 또는 호환 Chromium 브라우저 138 이상
- Windows x86_64 또는 Linux x86_64 동반 App
- 패키지 CLI용 Node.js 20 이상

### 1. 확장 프로그램과 App 다운로드

[최신 Release](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest)에서 ZIP 두 개를 다운로드하고 각각 별도 디렉터리에 압축을 풉니다.

- 확장 프로그램: `browser-key-automation-extension-v0.0.0.1.zip`
- 로컬 App: `browser-key-automation-local-app-v0.0.0.1.zip`

App ZIP에는 `windows-x86_64/`, `linux-x86_64/`, CLI와 Agent skill이 포함되어 있습니다. 소스 빌드는 필요하지 않습니다.

### 2. 확장 프로그램 로드

1. 확장 프로그램 아카이브를 완전히 풉니다.
2. `chrome://extensions`에서 개발자 모드를 켜고 **압축해제된 확장 프로그램을 로드합니다**.
3. 루트에 `manifest.json`이 직접 있는 압축 해제 디렉터리를 선택합니다.
4. 확장 프로그램 세부정보에서 **Allow User Scripts**를 켠 다음 확장 프로그램을 다시 로드합니다. 이 브라우저 소유 스위치는 `js.execute`에만 필요하며, 꺼져 있어도 Key 관리, DOM, 페이지 트리는 사용할 수 있습니다.
5. 툴바에서 **Browser Key Automation**을 엽니다. 완전히 신뢰하는 제어에는 Root Key를, 필요한 권한만 부여하려면 Regular Key를 만듭니다.

처음 설치할 때만 로컬 설정 페이지가 열립니다. 업데이트나 다시 로드할 때 반복해서 열리지 않습니다.

### 3. 동반 App 시작

GitHub Release App 아카이브를 풀고 현재 플랫폼의 relay를 계속 실행합니다.

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

기본 endpoint는 `127.0.0.1:32189`입니다. App에 연결할 수 없으면 확장 프로그램은 설정된 명목상 10초 간격으로 연결될 때까지 다시 시도합니다. 호환 App이 고정 endpoint를 이미 사용 중이면 두 번째 App을 시작하지 마십시오.

### 4. CLI 연결

압축을 푼 로컬 App 디렉터리에서 실행합니다.

```text
node client/browser-key-cli.mjs instances
```

이 명령에는 Key가 필요하지 않습니다. Instance가 0개면 확장 프로그램이 아직 연결되지 않은 것입니다. 여러 개라면 현재의 `relayEpoch/instanceNumber`를 명시적으로 선택하고 bearer Key를 모든 Instance에 시험하지 마십시오.

Key는 argv가 아니라 환경 변수로 전달합니다.

```powershell
# PowerShell
$env:BKA_API_KEY = "bk1.<key-id>.<secret>"
node .\client\browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

```bash
# Bash
export BKA_API_KEY='bk1.<key-id>.<secret>'
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json '{}'
```

CLI는 Key를 읽기 전에 Instance를 다시 열거합니다. delivery가 `unknown`이면 실제로 알 수 없는 상태로 취급하고, 부작용이 있는 명령을 자동 재시도하지 마십시오.

## 자주 쓰는 흐름

- 페이지 탐색: `tabs.list` → `page.tree.open` → `page.tree.find` 또는 `page.tree.expand.v2` → `page.tree.view.get`
- 페이지 동기화: `page.wait`. timeout을 생략하면 10초이며 이미 충족된 조건은 즉시 반환됩니다.
- 페이지 저장: `node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml`
- 뷰포트 캡처: `node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.png`
- 데모 열기: `node client/browser-key-cli.mjs demo-open ./demo.html`
- 익숙하지 않은 명령은 호출 전에 `skills/browser-key-automation/references/commands.registry.json`에서 확인하십시오. 패키지 Agent skill에도 같은 생성 참조가 포함됩니다.

### 네이티브 `.real` 클릭

`dom.click.real`은 `dom.click`과 독립된 명시적 기능입니다. Windows에서는 Chromium에 대상 탭 활성화와 브라우저 창 포커스를 요청하고, 참조 요소가 살아 있고 보이며 활성 상태이고 가려지지 않았는지 확인한 다음, 동반 App에 일치하는 Chromium 콘텐츠 창으로 네이티브 왼쪽 클릭 한 번을 보내도록 요청합니다.

`{ "status": "input_sent" }`는 입력 시퀀스가 받아들여졌다는 뜻일 뿐 웹사이트 업무가 완료되었다는 뜻은 아닙니다. 이후 페이지를 다시 관찰해야 합니다. 알 수 없거나 실패한 네이티브 입력을 자동 재생하지 마십시오. Linux App은 현재 `native.input.click.v1`을 광고하지 않으므로 확장 프로그램이 페이지 준비 전에 `.real`을 거부합니다.

## Key, 권한 및 점유

- 외부 신원은 Key 하나뿐입니다. Agent 브랜드, 프로세스, 계정, socket, App Instance는 추가 인증 신원이 아닙니다.
- Root는 모든 active 권한을 동적으로 가집니다. Regular는 명시적으로 선택된 권한만 가집니다.
- JavaScript, 일반 DOM 작업, 네이티브 `.real`, 네트워크 접근, 향후 디버깅 backend는 병렬 권한입니다. 하나를 부여해도 다른 권한이 암묵적으로 부여되지 않습니다.
- 같은 Key의 명령은 현재 확장 프로그램 runtime에서 직렬화됩니다. 서로 다른 Key는 독립 lane을 가지지만 동일 페이지에 대한 효과는 경합할 수 있습니다.
- 점유는 Key 소유입니다. 숨겨진 takeover, force, replace가 없으며 먼저 release하고 그다음 acquire해야 합니다.
- 전체 Key는 확장 프로그램 내부에 저장됩니다. 신뢰할 수 있는 관리 페이지와 `keys.create` 또는 `keys.reveal` 권한을 별도로 받은 호출자만 이를 받을 수 있습니다. 일반 목록과 진단에는 포함되지 않고, CLI는 `BKA_API_KEY` 또는 명시한 환경 변수에서만 읽습니다.

강력한 Key를 로컬 브라우저 제어 자격 증명처럼 취급하고 신뢰할 수 있는 Agent 또는 자동화에만 제공하십시오. 기술적 Key 권한은 결제, 게시, 메시지 전송, 계정 변경, 삭제 등 중요한 작업에 대한 사용자의 허가를 대신하지 않습니다.

## 브라우저 및 플랫폼 경계

host access, 제한된 페이지, file URL 접근, **Allow User Scripts**, 확장 프로그램 활성화, DevTools 디버깅 확인은 계속 Chromium이 제어합니다. Root도 이를 우회할 수 없습니다.

Windows와 Linux App은 모두 라우팅과 파일 저장을 제공합니다. Windows는 현재 네이티브 클릭 backend도 광고하지만 Linux는 아직 광고하지 않습니다. 시크릿 모드와 Chromium 파생 브라우저는 각각의 profile과 policy에서 검증해야 합니다.

Agent 연결: [Browser Key Automation skill](skills/browser-key-automation/SKILL.md).

이 프로젝트는 작성자가 유지 관리하며 외부 기여와 Pull Request를 받지 않습니다.
