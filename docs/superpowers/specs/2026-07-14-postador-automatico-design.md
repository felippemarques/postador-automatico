# Postador Automático — Fluxo n8n de Produção e Publicação de Vídeos

Data: 2026-07-14
Status: Aprovado (brainstorming) — aguardando plano de implementação

## Contexto e Motivação

Análise da landing page `nakagawakenzoo.github.io/automacao-de-videos.html` (produto "Automação de Vídeos" de Kenzo Nakagawa) revelou um fluxo n8n vendido como produto que gera e publica 1 vídeo/dia automaticamente (roteiro IA, narração, legenda, clipes de banco gratuito, thumbnail IA, render em 2 formatos, publicação agendada no YouTube), com custo operacional declarado de ~US$14/mês em APIs de IA.

Objetivo deste projeto: construir um fluxo equivalente **para uso próprio** (não para revenda), rodando na VPS do usuário (Oracle Cloud, VM.Standard.A1.Flex — ARM, 4 OCPU / 24GB RAM / 200GB disco), com n8n já instalado e MCP disponível para criação/gestão do fluxo.

## Requisitos

- Publicar em **YouTube + Shorts/TikTok/Reels** (formatos 16:9 e 9:16).
- **Multi-nicho**: usuário vai testar vários nichos, configuração de nicho deve ser parametrizável na instalação/execução, não hardcoded.
- Stack de IA deve começar **mais barata possível** e ser **flexível/escalável** — trocar provedor (LLM, TTS, imagem) sem redesenhar o fluxo.
- Modo de aprovação antes de publicar deve ser **configurável** (automático vs. manual com revisão humana).
- Render de vídeo via **FFmpeg no próprio VPS** (decisão do usuário, evita custo recorrente de API de render).

## Arquitetura

n8n orquestra o pipeline via **1 workflow principal + sub-workflows modulares**, chamados via node Execute Workflow:

```
Trigger diário (por nicho)
  → Roteiro (sub-workflow)
  → Voz (sub-workflow)
  → Legenda (sub-workflow)
  → Assets (sub-workflow: clipes + música)
  → Render (sub-workflow → chama microserviço FFmpeg)
  → Aprovação (condicional, conforme config do nicho)
  → Publish (sub-workflow: YouTube, e depois TikTok/IG)
```

Cada sub-workflow é testável isoladamente (chamada manual com input de teste), sem depender do pipeline inteiro rodando. Isso evita a fragilidade de um workflow monolítico gigante e permite trocar um provedor (ex.: TTS) sem tocar nos demais.

**Render de vídeo roda num microserviço sidecar** (Node.js ou Python, container Docker, exposto via HTTP no próprio VPS) em vez de comandos FFmpeg soltos em node Execute Command do n8n. Motivo: a composição final (concatenar clipes, embutir legenda com timing palavra-a-palavra, aplicar trilha sonora, exportar em 16:9 e 9:16) exige filtros FFmpeg complexos — manter isso em expressions do n8n é difícil de versionar, testar e debugar. O sidecar recebe um job JSON (lista de clipes, áudio, legendas com timestamps, música, textos de overlay) e devolve os caminhos dos 2 arquivos renderizados.

## Stack por Etapa

| Etapa | Serviço inicial (custo mínimo) | Troca futura | Observação |
|---|---|---|---|
| Roteiro | LLM via **OpenRouter** (ex. DeepSeek/Claude Haiku/GPT-4o-mini) | Trocar modelo só muda config, mesma API/credencial | ~1.400 palavras / 9 min, tema sem repetição |
| Narração | **Edge-TTS** (gratuito) | ElevenLabs (voz premium) | Abstraído numa interface de "provedor de voz" |
| Legenda | **faster-whisper** local (CPU, compatível arm64) | — | Gera timestamp palavra-a-palavra, funciona com qualquer TTS escolhido |
| Clipes | **Pexels API** (gratuito) | Pixabay como fallback | Busca por palavra-chave extraída do roteiro |
| Música | **Pixabay Music API** ou banco curado local | — | Crédito da faixa salvo pra usar na descrição do vídeo |
| Thumbnail | **Pollinations.ai** (gratuito, sem key) | fal.ai / Replicate (Flux) | Geração por prompt derivado do tema |
| Render | **FFmpeg** em microserviço sidecar no VPS | — | Ver seção Arquitetura |
| Publicação | **YouTube Data API v3** (long-form + Shorts) | TikTok Content Posting API, Instagram Graph API (fase 2) | Ver seção Riscos |

## Dados e Persistência

Banco **Postgres** (container adicional no docker-compose do VPS, ao lado do n8n) com tabelas:

- `niches` — nome, prompt template do roteiro, palavras-chave de busca de clipe, voice id, estilo, `approval_mode` (`auto`|`manual`).
- `topics_used` — histórico de temas já gerados por nicho, evita repetição.
- `video_runs` — id da execução, nicho, status (em progresso/aguardando aprovação/publicado/erro), links dos assets gerados, IDs de publicação por plataforma.
- `costs` — custo estimado por chamada de API, por vídeo, pra acompanhar contra a meta de ~US$14/mês.

## Fluxo de Aprovação (configurável)

Lido de `niches.approval_mode`:

- **Automático**: pipeline segue direto pra publicação assim que o render termina.
- **Manual**: workflow para antes do publish, envia mensagem Telegram com prévia (thumbnail, trecho do roteiro, link/preview do vídeo renderizado) com botões inline Aprovar/Rejeitar. Workflow aguarda em node Wait, callback do Telegram dispara continuação (aprovado → publish; rejeitado → marca `video_runs.status = rejeitado` e encerra, sem republicar).

## Multi-Nicho

Cada nicho é uma linha em `niches`. Trigger (Schedule Trigger, um por nicho ou um único trigger que itera nichos ativos) passa `niche_id` para os sub-workflows, que leem a config daquele nicho antes de gerar roteiro/buscar clipes/selecionar voz. Permite rodar múltiplos nichos em paralelo sem duplicar lógica.

## Erros e Observabilidade

- Error Trigger workflow dedicado, acionado por qualquer sub-workflow que falhar — envia alerta Telegram com `run_id`, nicho e etapa que falhou.
- Retry automático (configuração nativa do node) em falhas transitórias de chamada de API (rate limit, timeout).
- Limpeza periódica de arquivos temporários (clipes baixados, áudio intermediário, renders) — disco de 200GB não é infinito com uso diário continuado.
- Modo **dry-run**: opção de rodar pipeline completo (gera tudo) mas pula a etapa de publish, pra validar qualidade nos primeiros runs de um nicho novo sem publicar lixo.

## Riscos e Restrições Conhecidas

- **TikTok Content Posting API** e **Instagram Graph API** (Reels) exigem processo de app review/aprovação da respectiva plataforma antes de permitir publicação pública automatizada — isso é atraso de dias/semanas fora do controle do desenvolvimento, não é trabalho de build. **Decisão**: lançar com YouTube (16:9 + Shorts) primeiro; TikTok/Instagram entram como fase 2 assim que os apps estiverem aprovados.
- Arquitetura ARM (Oracle A1.Flex): usar imagens Docker `arm64`/multi-arch para todos os serviços (n8n, Postgres, sidecar de render, faster-whisper). Verificar disponibilidade de build arm64 de cada dependência durante a implementação.
- Nenhuma garantia de qualidade/resultado — mesma ressalva que a LP original: resultado varia por nicho e configuração de prompt.

## Fora de Escopo (nesta fase)

- Empacotamento como produto vendável (instalador, manual, distribuição via Kiwify etc.) — descartado; uso é próprio.
- Publicação em TikTok/Instagram — fase 2, dependente de aprovação de API externa.
- Painel visual de gestão (fica no Postgres + queries manuais ou Telegram por enquanto).

## MVP (primeira entrega)

1. Um nicho configurado.
2. Publicação somente YouTube (16:9 + Shorts).
3. `approval_mode = manual` (validar qualidade antes de automatizar).
4. Stack mais barata em cada etapa (OpenRouter modelo barato, Edge-TTS, Pexels, Pixabay Music, Pollinations.ai).

Depois do MVP validado: ligar `approval_mode = auto`, adicionar nichos, entrar fase 2 (TikTok/Instagram).
