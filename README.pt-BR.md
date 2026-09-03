# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | Português (Brasil) | [Русский](README.ru.md)

O Browser Key Automation transforma o navegador Chromium que você já usa em uma superfície de automação delimitada por Key para Agents e programas confiáveis. Depois de instalar a extensão uma vez e criar uma Key, um cliente autorizado pode trabalhar entre suas abas já autenticadas sem iniciar outro navegador de automação.

O caminho principal usa APIs comuns de extensão, não CDP, WebDriver, opções remote-debugging ou `chrome.debugger`. O Chromium continua responsável pela instalação, acesso a sites e pela configuração única **Allow User Scripts**. Depois disso, comandos rotineiros não anexam um depurador nem exibem a confirmação ou barra de aviso de depuração do Chrome.

## Por que usar o Browser Key Automation

- **Controle contínuo do navegador que já está diante de você.** Liste, crie, selecione, navegue, recarregue e feche abas a qualquer momento, mantendo sessões, cookies, extensões e estados de página alcançados manualmente.
- **A página inteira em uma visão do tamanho certo para um Agent.** A árvore de operações canonical em cache mantém a estrutura geral visível, expande apenas os ramos solicitados e preserva o estado de cada Key até o documento mudar. Visões pontuais por profundidade, intervalo ou subárvore não alteram esse estado.
- **Confiança delimitada por Key, não um endpoint de depuração aberto.** Keys Root e Regular têm permissões, validade, nova revelação, desativação e revogação explícitas. Chamadas da mesma Key são serializadas; Keys diferentes trabalham de forma independente.
- **Clique nativo com um único sufixo.** No Windows, `dom.click.real` combina a geometria observada pela extensão com o App local para enviar um clique esquerdo no nível do sistema operacional quando uma página rejeita ativação DOM sintética. O alvo ainda precisa existir, estar visível, habilitado e desobstruído.
- **Arquivos são de primeira classe.** Salve MHTML, capture o viewport visível, obtenha recursos como Artifacts limitados e grave-os em disco, envie HTML autocontido e abra-o como demonstração sem servidor Web local.
- **Coordenação de vários clientes confiáveis.** Uma Key pode ocupar uma aba ou o escopo global para evitar estado inconsistente; outra Key autorizada precisa liberar explicitamente a ocupação antes de adquiri-la.

### Comparação de fluxos de trabalho

Modelos de conexão verificados em 2026-09-01. A tabela compara caminhos normais de uso, não limites teóricos de recursos.

| Abordagem | Chromium existente e autenticado | Caminho normal de controle | Melhor uso |
| --- | --- | --- | --- |
| **Browser Key Automation** | Sim, entre quaisquer abas autorizadas | APIs comuns de extensão + autenticação Key; o App local acrescenta roteamento, arquivos e clique `.real` opcional | Acesso Agent duradouro sem anexar depurador, árvore seletiva em cache e fluxos de arquivo integrados |
| [Playwright](https://playwright.dev/docs/api/class-browsertype), [Puppeteer](https://pptr.dev/guides/browser-management), [Selenium](https://www.selenium.dev/documentation/overview/) | O caminho comum cria uma sessão de automação; também é possível conectar um Chromium existente | Playwright/CDP, Puppeteer/CDP ou WebDriver | Testes determinísticos, validação entre navegadores, CI e ecossistemas maduros de locators e depuração |
| [Extensão Playwright MCP](https://github.com/microsoft/playwright/tree/main/packages/extension#readme) | Sim; um token de perfil pode remover sua própria aprovação posterior | Playwright retransmitido por uma extensão que declara a permissão `debugger` do Chrome | Ações Playwright e accessibility snapshots em abas existentes selecionadas |
| [Chrome DevTools MCP](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) | Sim, depois de ativar remote debugging ou expor um endpoint de depuração | DevTools/CDP; o auto-connect do Chrome solicita permissão para cada sessão de depuração | Diagnóstico profundo com Console, Network, Performance, memória e outros DevTools |
| [Browser MCP](https://browsermcp.io/) | Sim, depois que o usuário conecta a aba atual | Extensão + MCP local, limitado à aba de trabalho conectada explicitamente | Uma superfície MCP compacta para uma aba existente escolhida |
| [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | Sim, entre abas | Extensão + native-messaging bridge; o manifest solicita `debugger` além de permissões comuns | Ferramentas MCP amplas entre abas, captura de rede, downloads e upload de arquivos |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | Sim | Agent integrado ao navegador sobre Puppeteer/CDP, com Keys do LLM provider fornecidas pelo usuário | Uma UI multi-Agent integrada, não um plano de controle independente do provider |

O Browser Key Automation não substitui suítes de teste Playwright/Selenium nem diagnósticos profundos do DevTools. Ele ocupa outro papel: controle autorizado e de baixo atrito do navegador que uma pessoa já usa, com estrutura limpa e recursos de arquivo suficientes para um Agent concluir trabalho real.

> Distribuição: o [GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) fornece uma extensão unpacked para Chrome/Chromium 138 ou posterior e um App local separado. A publicação na Chrome Web Store segue um processo independente. Cada Release tem exatamente dois downloads: `browser-key-automation-extension-v0.0.0.3.zip` e `browser-key-automation-local-app-v0.0.0.3.zip`.

## Recursos

- Criar, revelar novamente, copiar, atualizar, desativar e revogar Keys Root ou Regular em uma página de administração local. Uma Key completa salva pode ser exibida novamente no futuro.
- Listar abas e usar `TabRef`, `DocumentRef`, `NodeRef`, `TreeRef` e `ArtifactRef` vinculados ao runtime, em vez de IDs brutos do navegador.
- Explorar uma árvore de operações da página em cache. O estado de expansão pertence a cada Key e permanece ao sair e retornar à página, até que o documento seja atualizado ou substituído.
- Encontrar nós sem expandir a árvore, pedir visões pontuais por profundidade, intervalo de irmãos ou subárvore, ler live DOM limitado, descrever nós e executar ações DOM.
- Executar JavaScript em um world `USER_SCRIPT` ou `MAIN` explícito quando **Allow User Scripts** estiver habilitado no Chromium.
- Aguardar navegação, `interactive`, `complete`, uma condição DOM ou de texto.
- Salvar a página atual como MHTML, capturar uma imagem verificada do viewport, transferir Artifacts limitados e abrir demonstrações HTML autocontidas sem servidor HTTP local.
- Enviar um clique esquerdo nativo do Windows com `dom.click.real`, cuja permissão é independente de `dom.click`.
- Permitir que uma Key ocupe uma aba ou o escopo global. Outra Key autorizada precisa liberar explicitamente a ocupação antes de adquiri-la.

O Command Registry é a fonte de verdade para métodos, schemas, permissões e erros exatos. `system.describe` retorna o build ativo e as permissões efetivas da Key que fez a chamada.

## Início rápido

### Requisitos

- Chrome ou navegador Chromium compatível, versão 138 ou posterior
- App complementar para Windows x86_64 ou Linux x86_64
- Node.js 20 ou posterior para a CLI incluída

### 1. Baixar a extensão e o App

Baixe os dois ZIPs da [Release mais recente](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) e extraia cada um em uma pasta separada.

- Extensão: `browser-key-automation-extension-v0.0.0.3.zip`
- App local: `browser-key-automation-local-app-v0.0.0.3.zip`

O ZIP do App inclui `windows-x86_64/` e `linux-x86_64/`, além da CLI e do skill de Agent. Não é necessário compilar o código-fonte.

### 2. Carregar a extensão

1. Extrair completamente o arquivo da extensão.
2. Abrir `chrome://extensions`, ativar o modo do desenvolvedor e escolher **Carregar sem compactação**.
3. Selecionar o diretório extraído cuja raiz contém diretamente `manifest.json`.
4. Nos detalhes da extensão, ativar **Allow User Scripts** e recarregar a extensão. Essa opção controlada pelo navegador só é necessária para `js.execute`; administração de Keys, DOM e árvore da página continuam disponíveis sem ela.
5. Abrir **Browser Key Automation** pela barra de ferramentas. Criar uma Root Key para controle totalmente confiável ou uma Regular Key apenas com as permissões necessárias.

A primeira instalação abre uma página local de configuração. Atualizações e recarregamentos não a abrem repetidamente.

### 3. Iniciar o App complementar

Extrair o arquivo do App do GitHub Release e manter em execução o relay da plataforma atual:

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

O endpoint padrão é `127.0.0.1:32189`. Se o App estiver indisponível, a extensão tenta novamente no intervalo nominal configurado de 10 segundos até se conectar. Não iniciar um segundo App quando uma instância compatível já possui o endpoint fixo.

### 4. Conectar a CLI

No diretório extraído do App local:

```text
node client/browser-key-cli.mjs instances
```

Esse comando não exige Key. Zero instâncias significa que nenhuma extensão está conectada. Se houver várias, selecionar explicitamente uma `relayEpoch/instanceNumber` atual; nunca testar uma bearer Key em todas as instâncias.

Fornecer a Key por variável de ambiente, nunca por argv:

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

A CLI enumera novamente as instâncias antes de ler a Key. Se delivery for `unknown`, o resultado é realmente desconhecido; não repetir automaticamente um comando com efeitos.

## Fluxos comuns

- Descoberta da página: `tabs.list` → `page.tree.open` → `page.tree.find` ou `page.tree.expand.v2` → `page.tree.view.get`
- Sincronização: `page.wait`; sem timeout, são usados 10 segundos, e uma condição já satisfeita retorna imediatamente.
- Salvar página: `node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml`
- Capturar viewport: `node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.png`
- Abrir demonstração: `node client/browser-key-cli.mjs demo-open ./demo.html`
- Antes de usar um comando desconhecido, consultar `skills/browser-key-automation/references/commands.registry.json`. O skill de Agent incluído contém as mesmas referências geradas.

### Imagens de elementos e depuração explícita

`page.screenshot.element` permite ao Agent visualizar Canvas, gráficos ou contêineres usando a NodeRef existente. Inclui filhos visíveis, mascara as formas compatíveis e centraliza o conjunto proporcionalmente em um PNG transparente com dimensões exatas. Não exige calcular coordenadas de tela nem anexar um depurador.

```text
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
```

Para diagnóstico aprofundado: `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach`. A permissão independente `debugger` oferece comandos e eventos CDP; a confirmação e o aviso de depuração do próprio Chrome permanecem. Operações comuns continuam no caminho habitual.

A captura de elementos usa apenas o viewport atual de uma aba já ativa, sem rolagem automática nem reconstrução de conteúdo oculto. Formas compatíveis, escopo do documento principal, regiões locais, resultados CDP grandes e tratamento de falhas estão no [guia do Agent](skills/browser-key-automation/references/debugger-and-element-capture.md).

### Clique nativo `.real`

`dom.click.real` é explícito e independente de `dom.click`. No Windows, ele solicita ao Chromium que ative a aba de destino e dê foco à janela do navegador, verifica se o elemento referenciado ainda existe, está visível, habilitado e desobstruído e então pede ao App que envie um único clique esquerdo nativo à janela de conteúdo Chromium correspondente.

`{ "status": "input_sent" }` significa apenas que uma sequência de entrada foi aceita, e não que o site concluiu a ação de negócio. Observe a página depois. Nunca repita automaticamente uma entrada nativa desconhecida ou com falha. O App Linux atualmente não anuncia `native.input.click.v1`; portanto, a extensão rejeita `.real` antes de preparar a página.

## Keys, permissões e ocupações

- Uma Key é a única identidade externa. Marca do Agent, processo, conta, socket e Instance do App não são identidades adicionais de autorização.
- Root recebe dinamicamente todas as permissões ativas. Regular recebe somente permissões escolhidas explicitamente.
- JavaScript, ações DOM comuns, entrada nativa `.real`, acesso à rede e acesso explícito `debugger` são permissões paralelas; uma não concede silenciosamente as outras.
- Comandos da mesma Key são serializados no runtime atual da extensão. Keys diferentes têm lanes independentes, mas seus efeitos na mesma página podem competir.
- Uma ocupação pertence a uma Key. Não existe takeover, force ou replace oculto: primeiro release, depois acquire.
- A Key completa permanece dentro da extensão. A página de administração confiável e chamadores autorizados separadamente para `keys.create` ou `keys.reveal` podem recebê-la; listas e diagnósticos comuns não a incluem. A CLI a lê apenas de `BKA_API_KEY` ou de uma variável de ambiente escolhida explicitamente.

Trate uma Key poderosa como uma credencial local de controle do navegador e entregue-a apenas a Agents ou automações confiáveis. Uma permissão técnica nunca substitui a autorização do usuário para pagamentos, publicações, mensagens, alterações de conta, exclusões ou outras ações importantes.

## Limites do navegador e da plataforma

O Chromium continua controlando host access, páginas restritas, acesso a file URLs, **Allow User Scripts**, ativação da extensão e qualquer confirmação de depuração do DevTools. Root não pode contornar esses limites.

Os Apps Windows e Linux fornecem roteamento e escrita de arquivos. O Windows também anuncia o backend atual de clique nativo; o Linux ainda não. O modo anônimo e derivados do Chromium precisam ser verificados com seus próprios perfis e políticas.

Configuração do Agent: [Browser Key Automation skill](skills/browser-key-automation/SKILL.md).

Este projeto é mantido pelo autor. Contribuições externas e Pull Requests não são aceitas.
