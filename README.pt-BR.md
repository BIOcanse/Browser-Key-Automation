# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | Português (Brasil) | [Русский](README.ru.md)

O Browser Key Automation permite que um Agent ou programa de automação confiável controle um navegador Chromium local autorizado por meio de uma extensão Manifest V3 e uma API Key.

A extensão é dona da autenticação das Keys, das permissões, das referências do navegador, das ocupações e das operações do navegador. O pequeno App complementar em Zig fornece somente roteamento local, referências de Instance atribuídas pelo App, gravação de arquivos e as capacidades nativas que ele anuncia explicitamente.

> Estado de desenvolvimento: o build de desenvolvimento unpacked atual é voltado para Chrome/Chromium 138 ou posterior. Ele não é uma publicação da Chrome Web Store.

O trabalho da Chrome Web Store está pausado até o design do ícone final. Use [GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases): cada Release tem exatamente dois downloads, `browser-key-automation-extension-v0.0.0.1.zip` e `browser-key-automation-local-app-v0.0.0.1.zip`. Consulte o [contrato de entrega do GitHub Release](docs/implementation/github-release-delivery.md).

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

## Arquitetura

```text
Agent / automação
        |
        | BKA_API_KEY + command
        v
App complementar Zig para Windows ou Linux
        |
        | route loopback local + InstanceRef atribuída pelo App
        v
MV3 offscreen transport
        |
        v
service worker da extensão
        |
        +-- autenticação das Keys e permissões
        +-- ocupações e referências runtime
        +-- abas, árvore da página, DOM, JavaScript e Artifacts
        `-- solicitação opcional de capacidade da plataforma
```

A extensão é a única dona do estado de negócio. O App complementar não mantém um banco de Keys nem decide permissões do navegador. O App atribui uma referência de Instance a cada extensão conectada; a extensão nunca cria nem persiste seu próprio número de instância.

O caminho principal usa permissões comuns de extensão. CDP/DevTools pode continuar como uma capacidade opcional separada, mas este projeto não pode remover a confirmação de depuração do próprio Chromium.

## Início rápido

### Requisitos

- Chrome ou navegador Chromium compatível, versão 138 ou posterior
- App complementar para Windows x86_64 ou Linux x86_64
- Node.js 20 ou posterior para a CLI incluída
- Zig somente para compilar o App a partir do código-fonte

### 1. Compilar os pacotes separados

```text
npm ci
npm run build:dev-package
```

O build produz três arquivos independentes:

- `out/browser-key-automation-extension-dev.zip`
- `out/browser-key-automation-local-app-windows-x86_64-dev.zip`
- `out/browser-key-automation-local-app-linux-x86_64-dev.zip`

A extensão e o App local são entregues separadamente de propósito. Cada arquivo contém seu próprio `START-HERE.md` e `SHA256SUMS.txt`.

`npm run build:github-release` reúne esses intermediários verificados em dois assets do GitHub: um ZIP da extensão e um ZIP do App com os relays `windows-x86_64/` e `linux-x86_64/`, além de uma única cópia compartilhada da CLI, do protocolo e do skill do Agent.

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

Os intermediários App `-dev` específicos de plataforma ainda colocam o relay na raiz do arquivo; siga o `START-HERE.md` incluído ao usá-los.

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

### Clique nativo `.real`

`dom.click.real` é explícito e independente de `dom.click`. No Windows, ele solicita ao Chromium que ative a aba de destino e dê foco à janela do navegador, verifica se o elemento referenciado ainda existe, está visível, habilitado e desobstruído e então pede ao App que envie um único clique esquerdo nativo à janela de conteúdo Chromium correspondente.

`{ "status": "input_sent" }` significa apenas que uma sequência de entrada foi aceita, e não que o site concluiu a ação de negócio. Observe a página depois. Nunca repita automaticamente uma entrada nativa desconhecida ou com falha. O App Linux atualmente não anuncia `native.input.click.v1`; portanto, a extensão rejeita `.real` antes de preparar a página.

## Keys, permissões e ocupações

- Uma Key é a única identidade externa. Marca do Agent, processo, conta, socket e Instance do App não são identidades adicionais de autorização.
- Root recebe dinamicamente todas as permissões ativas. Regular recebe somente permissões escolhidas explicitamente.
- JavaScript, ações DOM comuns, entrada nativa `.real`, acesso à rede e futuros backends de depuração são permissões paralelas; uma não concede silenciosamente as outras.
- Comandos da mesma Key são serializados no runtime atual da extensão. Keys diferentes têm lanes independentes, mas seus efeitos na mesma página podem competir.
- Uma ocupação pertence a uma Key. Não existe takeover, force ou replace oculto: primeiro release, depois acquire.
- A Key completa permanece dentro da extensão. A página de administração confiável e chamadores autorizados separadamente para `keys.create` ou `keys.reveal` podem recebê-la; listas e diagnósticos comuns não a incluem. A CLI a lê apenas de `BKA_API_KEY` ou de uma variável de ambiente escolhida explicitamente.

Trate uma Key poderosa como uma credencial local de controle do navegador e entregue-a apenas a Agents ou automações confiáveis. Uma permissão técnica nunca substitui a autorização do usuário para pagamentos, publicações, mensagens, alterações de conta, exclusões ou outras ações importantes.

## Limites do navegador e da plataforma

O Chromium continua controlando host access, páginas restritas, acesso a file URLs, **Allow User Scripts**, ativação da extensão e qualquer confirmação de depuração do DevTools. Root não pode contornar esses limites.

Os Apps Windows e Linux fornecem roteamento e escrita de arquivos. O Windows também anuncia o backend atual de clique nativo; o Linux ainda não. O modo anônimo e derivados do Chromium precisam ser verificados com seus próprios perfis e políticas.

## Desenvolvimento

| Comando | Finalidade |
|---|---|
| `npm run generate` | Gerar projeções de comandos, UI, transporte, capacidades e Freedom Points |
| `npm run check:extension` | Regenerar e verificar tipos de todos os realms da extensão |
| `npm run build` | Compilar a extensão e o App Zig da plataforma atual |
| `npm run test:unit` | Testes unitários de UI, Key, runtime, WebSocket e Zig |
| `npm run test:runtime` | Testes unitários mais integração isolada relay/Chromium |
| `npm run build:dev-package` | Criar a extensão e os Apps das duas plataformas |
| `npm run build:github-release` | Criar exatamente os dois ZIP publicados no GitHub Releases |
| `npm run build:chrome-web-store:first-upload` | Criar o artefato de identidade pausado; não fazer upload antes de retomar o trabalho do ícone |
| `npm run test:dev-package-smoke` | Verificar estrutura, executáveis, hashes e referências do skill |

Os testes de integração isolados usam portas, perfis e processos relay temporários. Eles não devem apontar para um perfil de navegador pessoal nem para uma Instance de App pessoal existente.

## Documentação

- [Índice da documentação](docs/README.md)
- [Decisões atuais](docs/decisions.md)
- [Progresso e estado verificado](docs/PROGRESS.md)
- [Contrato de comandos](docs/contracts/commands.md)
- [Árvore de operações da página](docs/design/page-information-tree.md)
- [Freedom Points](docs/design/freedom-points.md)
- [Estrutura de entrega](docs/design/delivery-layout.md)
- [Skill de Agent](skills/browser-key-automation/SKILL.md)

As propostas antigas Cleaner/PageIR permanecem somente em `docs/historical/` e não descrevem o comportamento atual do produto.
