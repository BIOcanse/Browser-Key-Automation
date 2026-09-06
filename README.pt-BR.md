# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | Português (Brasil) | [Русский](README.ru.md)

**Seu navegador de sempre, agora também para seu Agent.**

Trabalhe nas abas Chromium já autenticadas: leia, aja e salve o resultado. Comandos comuns usam permissões da extensão, sem navegador separado, conexão automática de depurador ou confirmação própria a cada comando. As verificações do navegador continuam valendo.

## O que facilita

- **Leia o necessário.** A árvore em cache mantém a estrutura geral e expande apenas os ramos pedidos. O estado permanece entre abas enquanto o documento não mudar. Profundidade, intervalo e subárvore são visualizações pontuais, não limpeza com perda.
- **Trabalhe entre abas.** Referências explícitas, execução serial por Key e ocupação de abas, janelas ou escopo global reduzem conflitos.
- **Leve o resultado.** MHTML, imagens de páginas ou elementos Canvas, transferência de recursos e demos HTML sem servidor local.
- **Escolha a entrada.** DOM, entrada real do Windows, mouse/teclado virtuais independentes e CDP opcional.
- **Confira o efeito.** `ensure.run` combina condições, preparação limitada, ação e meta observável. Resultados desconhecidos não provocam repetição cega.

## Primeiros passos

> Cada instalação nova cria a mesma **Key Root pública de teste**, documentada no skill do Agent. Ela não é uma credencial privada. No navegador pessoal, crie uma Key privada, altere os clientes e revogue a de teste. Criar outra não desativa a anterior. Atualizações não a recriam.

1. Requer Chromium **138+**, Windows ou Linux x64 e **Node.js 20+** para a CLI. Baixe os dois ZIPs da [última versão](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) e extraia separadamente.

   - `browser-key-automation-extension-v0.0.0.5.zip`
   - `browser-key-automation-local-app-v0.0.0.5.zip`

2. Em `chrome://extensions`, ative o modo de desenvolvedor e carregue a pasta com `manifest.json`. Gerencie Keys pelo ícone. **Allow User Scripts** é necessário para `js.execute`, não para DOM ou árvore.

3. Inicie o App com os comandos abaixo. No Windows, mantenha `virtual-mouse-hook.dll` junto do executável. A extensão tenta novamente `127.0.0.1:32189` a cada cerca de 10 segundos.

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

4. Carregue o `skill/browser-key-automation/SKILL.md` incluído no Agent. Liste as instâncias e escolha o navegador. Passe a Key privada por `BKA_API_KEY`, nunca como argumento, e não a teste em todas as instâncias.

```text
node client/browser-key-cli.mjs instances
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

## Da página ao resultado

Consulte versão e permissões com `system.describe`; os parâmetros exatos estão no [registro de comandos](dev/skills/browser-key-automation/references/commands.registry.json).

| | API / CLI |
| --- | --- |
| Explorar, selecionar, expandir | `tabs.list` → `page.tree.open` → `page.tree.find` / `page.tree.expand.v2` → `page.tree.view.get` |
| Esperar condição da página | `page.wait` · `ensure.run` |
| Salvar página / capturar página ou elemento | `page-save` · `page-shot` · `element-shot` |
| Enviar e exibir HTML | `demo-open` |
| DOM / clique real | `dom.click` · `dom.click.real` |
| Texto / atalhos / soltar teclas | `keyboard.type` · `keyboard.typeHuman` · `keyboard.press` · `keyboard.reset` |
| Mouse / teclado virtuais | `virtualMouse.*` · `virtualKeyboard.*` |
| Medir alvo nativo | `input.calibrate` |
| Sessão CDP explícita | `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach` |

```text
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
node client/browser-key-cli.mjs demo-open ./demo.html
```

## Keys e limites de entrada

- Root recebe todas as permissões ativas. Keys Regular oferecem grupos expansíveis, validade, nova visualização, desativação e revogação. JavaScript e entrada nativa são permissões independentes. Uma Key não substitui consentimento para pagar, publicar ou excluir.
- O estado virtual pertence à Key, persiste entre abas e exige ocupar toda a janela alvo. Ações virtuais comuns usam um `input.calibrate` válido; `ensure.run` verifica e atualiza quando preciso. Entrada real exige primeiro plano; a virtual não move o cursor físico.
- Windows fornece entrada nativa. Linux fornece atualmente roteamento do navegador e arquivos, não entrada nativa. Janelas minimizadas não são suportadas. A primeira calibração exige página mensurável; reutilização com janela coberta é condicional. Há casos pendentes de calibração inicial multijanela e arrastar/soltar HTML5/OLE nativo completo.
- Imagens de elementos usam o viewport visível e máscaras de formas suportadas. Chrome controla páginas restritas, acesso a sites e User Scripts; `debugger.attach` mantém o aviso de depuração. Eventos sintéticos e mensagens virtuais não contornam todas as restrições.

## Quando escolher

BKA prioriza o navegador pessoal, árvores seletivas e fluxos integrados de ações e arquivos. Não substitui universalmente frameworks de testes ou DevTools.

| | |
| --- | --- |
| [Playwright](https://playwright.dev/docs/intro) · [Selenium](https://www.selenium.dev/documentation/overview/) | Testes multinavegador e CI |
| [Puppeteer](https://pptr.dev/) | Automação programável |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Ferramentas Agent com snapshots de acessibilidade |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Diagnóstico profundo do navegador |
| [Browser MCP](https://browsermcp.io/) · [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | Ferramentas MCP para navegadores existentes |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | Interface Agent no navegador |

## Guias e manutenção

[Agent skill](dev/skills/browser-key-automation/SKILL.md) · [Operation tree](dev/skills/browser-key-automation/references/operation-tree.md) · [Ensure](dev/skills/browser-key-automation/references/ensure-workflows.md) · [Virtual input](dev/skills/browser-key-automation/references/virtual-mouse.md) · [Capture & CDP](dev/skills/browser-key-automation/references/debugger-and-element-capture.md)

A interface oferece 20 idiomas; os READMEs têm dez variantes. [Privacidade](PRIVACY.md) · [Estrutura de desenvolvimento](dev/README.md). Mantido pelo autor; contribuições externas e Pull Requests não são aceitos.
