# Guia para agentes

Este arquivo explica como alterar esta skill sem quebrá-la.

## O que este repositório contém

Uma skill de agente que controla o NextDNS pela API HTTP documentada (`https://api.nextdns.io`), com um CLI fino em Node que imprime JSON.

- `SKILL.md` é a fonte da verdade da skill.
- `scripts/nextdns.mjs` é o CLI (Node 18+, sem dependências).
- `tests/nextdns.test.mjs` roda o CLI contra um mock da API.
- `README.md` documenta instalação, configuração e desenvolvimento.
- `.claude-plugin/plugin.json` e `.claude-plugin/marketplace.json` descrevem o plugin do Claude Code e apontam o carregador de skill para o `SKILL.md` na raiz.

Não há etapa de build.

## Regras para mudanças

- Mantenha a skill em inglês e portável entre agentes. Não escreva instruções que limitem a uma ou duas ferramentas de agente específicas.
- Credenciais só por variáveis de ambiente (`NEXTDNS_API_KEY`). Nunca coloque chaves em código, exemplos ou logs.
- A skill lê por padrão. Ações que mudam estado exigem confirmação do usuário; mantenha essa regra no `SKILL.md`.
- O CLI usa só a biblioteca padrão do Node. Não acrescente dependências.
- O `parseArgs` do Node rejeita valores que começam com hífen; o CLI normaliza `--from -24h` para `--from=-24h` antes do parse. Não remova essa normalização: as datas relativas do NextDNS dependem dela.
- O streaming de logs (`logs --stream`) exige sempre um limite (`--max-events` ou `--duration`); sessão sem limite trava o agente. Para encerrar o stream no meio do `for await`, use `break`: o iterador cancela o stream. Chamar `response.body.cancel()` com o iterador ativo lança `ReadableStream is locked`.
- O endpoint de rewrites não tem PATCH na API: mudar um rewrite é remover e recriar. O CLI resolve nomes para ids antes de deletar e aborta se algum alvo não casa; preserve essas duas garantias.
- Mantenha os dois arquivos `.claude-plugin/` em sincronia com o `SKILL.md` (nome, descrição, palavras-chave). Ao mudar o comportamento da skill, suba a versão no `plugin.json`.
- OpenCode não usa manifest de plugin para skills: elas são descobertas dos diretórios de skills (`~/.config/opencode/skills`, `~/.claude/skills`, `.agents/skills`) ou instaladas pelo CLI do skills.sh. Não crie manifest para o OpenCode.

## Verificações

Antes de publicar, rode os testes:

```sh
node --test tests/*.test.mjs
```

Nenhuma conta NextDNS é necessária; os testes usam um mock da API.

## Estilo de escrita

Linguagem simples e direta: voz ativa, frases curtas, um único termo para a mesma coisa. Identificadores, comandos, saídas de API e mensagens de erro ficam exatamente como são. Em português, acentuação e crase corretas.
