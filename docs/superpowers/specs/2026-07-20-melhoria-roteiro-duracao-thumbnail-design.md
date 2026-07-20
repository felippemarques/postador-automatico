# Melhoria de Roteiro, Duração e Thumbnail (Design de Implementação)

Data: 2026-07-20
Status: Aprovado (brainstorming) — aguardando plano de implementação

## Problema

Depois da primeira execução ponta-a-ponta real (ver CLAUDE.md, seção "Status atual"), 3 problemas de qualidade de conteúdo ficaram claros:

1. **Roteiro pobre**: o prompt do sub-workflow Roteiro só pede "invente um tema novo, celebre o poder da criança" — sem estrutura de história (sem personagem, sem situação concreta, sem virada). Resultado é texto genérico.
2. **Vídeo muito curto**: o mesmo script (~130-160 palavras, ~60-75s) alimenta os 2 formatos de saída (16:9 e 9:16/Shorts). Isso é adequado pra Shorts, mas curto demais pra long-form 16:9.
3. **Thumbnail com título cortado**: `render-service`'s `buildThumbnailArgs` (`render-service/src/compose.js`) usa `drawtext` com `fontsize=64` fixo, sem quebra de linha e sem ajuste de tamanho. Títulos mais longos vazam da largura da imagem.

Contribuinte adicional pro problema 1 e pro "conteúdo limitado" citado pelo usuário: o sub-workflow Assets busca clipes só com 4 keywords **estáticas** do nicho (`niches.clip_keywords`: `kids playing`, `family home`, `children sharing`, `siblings`) — nunca usa o tema do episódio do dia, então o clipe nunca é realmente relevante ao roteiro.

## Decisão: separar 16:9 (long-form) de Shorts (curto)

Em vez de esticar um único script pros 2 formatos, o Roteiro passa a gerar **2 histórias própias** (não um corte da outra):

- `script_long`: 350-450 palavras (~2-3min), pro 16:9.
- `script_short`: 130-160 palavras (~60-75s), pro Shorts — mantém o alvo atual, que já era adequado pro formato.

Ambos seguem a mesma estrutura obrigatória de mini-história: **gancho inicial → situação concreta com personagem enfrentando o desafio do dia → momento de decisão/virada → celebração final**. Isso ataca o problema 1 (roteiro genérico) independente da duração.

Consequência arquitetural: como cada formato agora tem seu próprio script, os sub-workflows Voz, Legenda, Assets e Render (que hoje processam 1 script por run) passam a rodar **2x por run** — uma vez por variant.

## Contrato: `variant`

Hoje o Main Pipeline passa `{run_id, niche_id}` entre sub-workflows via Execute Workflow. Voz, Legenda, Assets e Render passam a receber também `variant: 'long' | 'short'`, e leem/gravam a coluna correspondente.

## Schema (`postador.video_runs`)

Novas colunas substituem as antigas (via `ALTER TABLE`, não recria o schema):

| Antiga | Novas |
|---|---|
| `script_text` | `script_long_text`, `script_short_text` |
| `voice_url` | `voice_long_url`, `voice_short_url` |
| `captions_json` | `captions_long_json`, `captions_short_json` |
| `assets_json` | `assets_long_json`, `assets_short_json` |
| `music_url` | `music_long_url`, `music_short_url` |

Nova coluna: `clip_keywords TEXT[]` — keywords específicas do episódio (não por variant; a história é a mesma, só a duração muda), geradas 1x pelo Roteiro.

Mantêm-se sem mudança: `topic`, `render_16x9_url`, `render_9x16_url`, `thumbnail_url`.

## Sub-workflows

### Roteiro

Uma única chamada ao OpenRouter (sem duplicar custo de LLM). Prompt reescrito pra pedir JSON:

```json
{
  "topic": "nome curto da missão (até ~40 caracteres)",
  "script_long": "roteiro de 350-450 palavras, estrutura de mini-história completa",
  "script_short": "roteiro de 130-160 palavras, mesma história condensada",
  "clip_keywords": ["4 a 6 termos em inglês específicos do episódio"]
}
```

- Estrutura de mini-história (gancho, situação concreta, virada, celebração) exigida nos 2 scripts; o `script_long` tem espaço pra mais de uma cena/exemplo, o `script_short` fica com 1 cena só.
- `topic` com cap de tamanho no prompt — rede de segurança pro título; a correção real do corte de texto é no thumbnail (ver abaixo).
- `clip_keywords`: termos em inglês (bibliotecas Pexels/Pixabay são em inglês), específicos do tema do dia (ex: "Missão Guarda-Brinquedos" → `child cleaning toys`, `organizing room`). Se o LLM devolver array vazio, cai no fallback de `niches.clip_keywords` (estático).
- Grava `script_long_text`, `script_short_text`, `clip_keywords`, `topic` em `video_runs`. Mantém histórico de `topics_used` como hoje.

### Voz / Legenda / Assets / Render (parametrização por `variant`)

- **Voz**: lê `script_long_text` ou `script_short_text` conforme `variant` → TTS → grava `voice_long_url`/`voice_short_url`.
- **Legenda**: lê a `voice_url` do variant correspondente → whisper-service → grava `captions_long_json`/`captions_short_json`.
- **Assets**: lê `clip_keywords` de `video_runs` (compartilhado, sem variant) em vez de `niches.clip_keywords` → busca Pexels/fallback Pixabay → grava `assets_long_json`/`assets_short_json`, `music_long_url`/`music_short_url`. Roda 2x (pode sortear música diferente por variant, sem problema).
- **Render**: lê os campos do variant correspondente → `render-service /render` → grava `render_16x9_url` (variant=`long`) ou `render_9x16_url` (variant=`short`). O node de thumbnail só roda quando `variant='long'` (IF node) — thumbnail é única por run (mascote + `topic` não depende de duração), grava `thumbnail_url`.

### Main Pipeline

A cadeia atual `Roteiro → Voz → Legenda → Assets → Render → Aprovação → Publish` passa a ser:

```
Roteiro → [Voz → Legenda → Assets → Render](variant=long) → [Voz → Legenda → Assets → Render](variant=short) → Aprovação → Publish
```

Sequencial, sem paralelismo (mesmo padrão de hoje — cada Execute Workflow espera o anterior terminar).

### Aprovação

Mensagem Telegram passa a incluir os 2 links (`render_16x9_url` e `render_9x16_url`, hoje só manda o 16:9) + trecho do `script_long_text`. Uma única aprovação decide os 2 formatos juntos (mesmo run, mesmo tema/dia).

### Publish

Upload 16:9 usa `script_long_text` na descrição (em vez do `script_text` que deixa de existir); upload 9:16 usa `script_short_text`. Resto do node (título, `made_for_kids`, atribuição de música) sem mudança.

## Thumbnail (render-service)

Correção de raiz em `render-service/src/compose.js`:

- `render.js` roda `ffprobe` no `mascotPath` antes de montar o `drawtext`, pra saber a largura real da imagem do mascote.
- `buildThumbnailArgs(mascotPath, text, outPath, canvasWidth)` passa a:
  1. Calcular quebra de linha do `text` em várias linhas com base na largura disponível (`canvasWidth` × margem de segurança ÷ largura estimada por caractere pro fontsize corrente).
  2. Reduzir `fontsize` dinamicamente (com um piso mínimo legível) até todas as linhas caberem dentro da largura com margem.
  3. Passar as linhas quebradas como texto multi-linha pro `drawtext` (newline real entre linhas, preservando o escaping de `:`/`'`/`%` já existente em `escapeDrawtext`).
- Isso corrige o corte independentemente do LLM respeitar o cap de caracteres do `topic` — o cap no prompt do Roteiro é só uma rede de segurança extra, não a correção principal.
- Regression test em `render-service/src/compose.test.js`: título longo (> largura da imagem no fontsize padrão) deve gerar 2+ linhas e/ou fontsize reduzido, e nenhuma linha deve estourar `canvasWidth` estimado.

## Fora de escopo

- Trocar o modelo do LLM (continua `deepseek/deepseek-chat` via OpenRouter) — o problema era estrutura do prompt, não o modelo.
- Aumentar quantidade/diversidade de resultados por keyword no Pexels/Pixabay (`per_page`) — fica pra uma iteração futura se `clip_keywords` por episódio não for suficiente.
- Aprovação separada por formato (aprovar 16:9 e rejeitar Shorts, por exemplo) — 1 aprovação cobre os 2.
- Thumbnail por variant (thumbnail única serve pros 2 formatos).
