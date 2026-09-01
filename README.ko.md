# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | 한국어 | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation은 신뢰할 수 있는 Agent 또는 자동화 프로그램이 Manifest V3 확장 프로그램과 API Key를 통해 권한이 부여된 로컬 Chromium 브라우저를 제어할 수 있게 합니다.

Key 인증, 권한, 브라우저 참조, 점유 및 브라우저 작업은 확장 프로그램이 소유합니다. 작은 Zig 동반 App은 로컬 라우팅, App이 할당한 브라우저 Instance 참조, 파일 저장, 그리고 명시적으로 광고한 네이티브 기능만 제공합니다.

> 개발 상태: 현재 unpacked 개발 빌드는 Chrome/Chromium 138 이상을 대상으로 합니다. Chrome 웹 스토어 릴리스가 아닙니다.

최종 아이콘 디자인이 끝날 때까지 Chrome Web Store 작업은 중단되었습니다. [GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases)를 사용하십시오. 각 Release에는 `browser-key-automation-extension-v0.0.0.1.zip`과 `browser-key-automation-local-app-v0.0.0.1.zip`, 정확히 두 개의 다운로드만 있습니다. [GitHub Release 전달 계약](docs/implementation/github-release-delivery.md)을 참조하십시오.

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

## 아키텍처

```text
Agent / 자동화
        |
        | BKA_API_KEY + command
        v
Windows 또는 Linux Zig 동반 App
        |
        | 로컬 loopback route + App 할당 InstanceRef
        v
MV3 offscreen transport
        |
        v
확장 프로그램 service worker
        |
        +-- Key 인증과 권한
        +-- 점유와 런타임 참조
        +-- 탭, 페이지 트리, DOM, JavaScript, Artifact
        `-- 선택적 플랫폼 기능 요청
```

확장 프로그램만 비즈니스 상태를 소유합니다. 동반 App은 Key 데이터베이스를 보관하지 않고 브라우저 권한도 결정하지 않습니다. 성공적으로 연결된 각 확장 프로그램의 Instance 참조는 App이 할당하며, 확장 프로그램이 자체 번호를 만들거나 저장하지 않습니다.

주 경로는 일반 확장 프로그램 권한을 사용합니다. CDP/DevTools는 별도의 선택 기능으로 둘 수 있지만 Chromium 자체의 디버깅 확인은 이 프로젝트가 제거할 수 없습니다.

## 빠른 시작

### 요구 사항

- Chrome 또는 호환 Chromium 브라우저 138 이상
- Windows x86_64 또는 Linux x86_64 동반 App
- 패키지 CLI용 Node.js 20 이상
- 소스에서 App을 빌드할 때만 Zig

### 1. 분리 패키지 빌드

```text
npm ci
npm run build:dev-package
```

서로 독립된 세 개의 아카이브가 생성됩니다.

- `out/browser-key-automation-extension-dev.zip`
- `out/browser-key-automation-local-app-windows-x86_64-dev.zip`
- `out/browser-key-automation-local-app-linux-x86_64-dev.zip`

확장 프로그램과 로컬 App은 의도적으로 따로 배포됩니다. 각 아카이브에 자체 `START-HERE.md`와 `SHA256SUMS.txt`가 있습니다.

`npm run build:github-release`는 검증된 중간 패키지를 GitHub용 두 자산으로 모읍니다. 확장 프로그램 ZIP 하나와 `windows-x86_64/`, `linux-x86_64/` relay 디렉터리 및 한 벌의 공용 CLI·protocol·Agent skill을 담은 App ZIP 하나입니다.

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

플랫폼별 `-dev` App 중간 패키지는 relay를 아카이브 루트에 둡니다. 개발 중간 패키지를 사용할 때는 동봉된 `START-HERE.md`를 따르십시오.

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

## 개발

| 명령 | 목적 |
|---|---|
| `npm run generate` | command, UI, transport, capability, Freedom Point 투영 생성 |
| `npm run check:extension` | 재생성 후 모든 확장 프로그램 realm 타입 검사 |
| `npm run build` | 확장 프로그램과 현재 플랫폼 Zig App 빌드 |
| `npm run test:unit` | UI, Key, runtime, WebSocket, Zig 단위 테스트 |
| `npm run test:runtime` | 단위 테스트와 격리 relay/Chromium 통합 테스트 |
| `npm run build:dev-package` | 확장 프로그램 및 두 플랫폼 App 패키지 빌드 |
| `npm run build:github-release` | GitHub Releases에 게시할 정확히 두 ZIP 빌드 |
| `npm run build:chrome-web-store:first-upload` | 중단된 ID 부트스트랩 산출물 빌드. 아이콘 작업 재개 전에는 업로드하지 않음 |
| `npm run test:dev-package-smoke` | 아카이브 구조, 실행 파일, 해시, skill 참조 검증 |

격리 통합 테스트는 임시 port, profile, relay를 사용합니다. 개인 브라우저 profile이나 기존 개인 App Instance를 대상으로 삼지 마십시오.

## 문서

- [문서 색인](docs/README.md)
- [현재 결정](docs/decisions.md)
- [진행 및 검증 상태](docs/PROGRESS.md)
- [명령 계약](docs/contracts/commands.md)
- [페이지 작업 트리](docs/design/page-information-tree.md)
- [Freedom Points](docs/design/freedom-points.md)
- [배포 구조](docs/design/delivery-layout.md)
- [Agent skill](skills/browser-key-automation/SKILL.md)

이전 Cleaner/PageIR 제안은 `docs/historical/`에만 보관되며 현재 제품 동작이 아닙니다.
