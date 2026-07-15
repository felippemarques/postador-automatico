# Workflows n8n — Pipeline de Produção "Esquadrão da Gentileza" (Design de Implementação)

Data: 2026-07-15
Status: Aprovado (brainstorming) — aguardando plano de implementação

Este documento detalha a implementação concreta do pipeline n8n descrito em `docs/superpowers/specs/2026-07-14-postador-automatico-design.md` (arquitetura macro já aprovada). Aqui ficam as decisões técnicas específicas pra construir, testar e publicar o MVP: nicho real, schema de dados, contrato entre sub-workflows, credenciais e plano de verificação.

## Contexto verificado nesta sessão

- n8n já rodando no VPS via Coolify (service `n8n-with-postgres-and-worker`), acessível em `https://n8n.wm10.info` (porta 443; a porta 5678 do fqdn interno do Coolify **não** é alcançável externamente, mas o proxy Traefik em 443 funciona).
- API REST do n8n confirmada ao vivo: `GET https://n8n.wm10.info/api/v1/workflows` com header `X-N8N-API-KEY` retorna 200. Nenhum workflow existe ainda (`{"data":[],"nextCursor":null}`).
- MCP do n8n conectado nesta sessão (`mcp__n8n__search_workflows`, `get_workflow_details`, `execute_workflow`) é só leitura/execução — não cria/edita workflow. Criação/edição é feita via API REST diretamente.
- Stack do n8n já inclui Postgres (`postgres:16-alpine`) e Redis (`redis:6-alpine`) próprios, internos à rede Docker do Coolify (sem porta pública). Usar esse mesmo Postgres, schema `postador` dedicado — não criar container novo.
- render-service e whisper-service já publicados e validados (ver `docs/superpowers/specs/2026-07-14-postador-automatico-design.md#endpoints-publicados`).
- Credenciais disponíveis: OpenRouter, Pexels, Pixabay, Telegram bot (token + chat_id) — o usuário já tem os valores prontos. YouTube OAuth já criado manualmente na UI do n8n (fluxo OAuth exige navegador, não dá pra automatizar via API).
- **Segurança**: nenhum valor secreto (API key do n8n, tokens de credencial, senha do Postgres) fica em arquivo versionado neste repo — só passam por chamadas de API pontuais.

## Nicho MVP: "Esquadrão da Gentileza"

Conteúdo infantil, boas maneiras tratadas como missões/superpoderes.

- **Persona**: "Capitão do Esquadrão" — animado, claro, encorajador. Zero tom de bronca (nunca "não faça X", sempre "heróis fazem Y"). Frases curtas, verbos de ação. Fecha sempre celebrando o poder da criança de deixar todo mundo mais feliz.
- **Formato**: cada vídeo é uma "missão" (ex: Missão Guarda-Brinquedos, Operação Ouvir os Pais, O Superpoder do Por Favor).
- **Exemplo de tom** (referência pro prompt do Roteiro): *"Atenção, Esquadrão! A missão de hoje é a Operação Super Ouvidos! Quando a mamãe ou o papai chamam, um verdadeiro herói responde de primeira e com atenção. Preparados para usar seus super ouvidos hoje? Então, missão dada é missão cumprida!"*
- **Voz**: Edge-TTS `pt-BR-AntonioNeural`.
- **Clipes**: busca Pexels/Pixabay por termos genéricos family-friendly (`kids playing`, `family home`, `children sharing`, `siblings`) — vídeo de crianças reais em banco de imagens é aceitável, diferente de gerar crianças via IA.
- **Thumbnail**: **mascote fixo** do Esquadrão (personagem ilustrado, não criança real, gerado uma única vez) — evita depender de geração de imagem IA por vídeo (Pollinations.ai e afins restringem prompts com crianças reais). Cada thumbnail é a composição do mascote + texto da missão do dia, sem chamada de IA de imagem no loop diário.
- **YouTube**: canal novo, marcado como `made_for_kids=true` (COPPA) — sem comentários, sem anúncio personalizado, conforme regra do YouTube pra conteúdo infantil.

## Schema Postgres (`postador`)

```sql
CREATE SCHEMA postador;

CREATE TABLE postador.niches (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  clip_keywords TEXT[],
  voice_id TEXT NOT NULL,
  mascot_image_url TEXT,
  approval_mode TEXT NOT NULL DEFAULT 'manual',
  youtube_made_for_kids BOOLEAN NOT NULL DEFAULT true,
  dry_run BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE postador.topics_used (
  id SERIAL PRIMARY KEY,
  niche_id INTEGER NOT NULL REFERENCES postador.niches(id),
  topic TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE postador.video_runs (
  id SERIAL PRIMARY KEY,
  niche_id INTEGER NOT NULL REFERENCES postador.niches(id),
  status TEXT NOT NULL DEFAULT 'em_progresso',
  -- em_progresso | aguardando_aprovacao | aprovado | rejeitado | publicado | erro
  current_step TEXT,
  topic TEXT,
  script_text TEXT,
  voice_url TEXT,
  render_16x9_url TEXT,
  render_9x16_url TEXT,
  thumbnail_url TEXT,
  youtube_video_id TEXT,
  youtube_shorts_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE postador.costs (
  id SERIAL PRIMARY KEY,
  video_run_id INTEGER NOT NULL REFERENCES postador.video_runs(id),
  step TEXT NOT NULL,
  provider TEXT NOT NULL,
  estimated_cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Arquitetura de Workflows

Um workflow principal (`Main Pipeline`) chama sub-workflows via node **Execute Workflow**, passando só `{ run_id, niche_id }`. Cada sub-workflow lê o que precisa de `niches`/`video_runs` no Postgres e grava seu resultado de volta na mesma linha antes de retornar — nenhum payload gigante é arrastado entre nodes, e cada etapa é testável isolada (basta um `run_id` de teste populado).

1. **Roteiro** — lê `prompt_template` + histórico de `topics_used` (evita repetir missão), chama OpenRouter, gera `topic` + `script_text`. Grava em `video_runs`, insere em `topics_used`.
2. **Voz** — `script_text` → Edge-TTS (`voice_id`) → mp3 → grava `voice_url`.
3. **Legenda** — chama `whisper-service /transcribe` com `voice_url` → grava `words`/`segments` (usado no Render pro SRT com timing palavra-a-palavra).
4. **Assets** — extrai keywords do `script_text`/`clip_keywords` → busca clipes (Pexels, fallback Pixabay) + música (Pixabay Music).
5. **Render** — monta job JSON (clipes, voice_url, música, captions) → chama `render-service /render` → grava `render_16x9_url`/`render_9x16_url`. Thumbnail = composição do `mascot_image_url` + texto da missão (sem IA de imagem no loop).
6. **Aprovação** — se `approval_mode=manual`: Telegram (thumbnail + trecho do roteiro + link do render) com botões Aprovar/Rejeitar, workflow em Wait até callback. Se `auto`: segue direto.
7. **Publish** — sobe os 2 formatos no YouTube Data API v3, `made_for_kids` conforme config, grava IDs, status `publicado`. Se `dry_run=true`: loga o que faria e para, sem publicar de fato.

Trigger: Schedule Trigger diário no Main Pipeline, itera nichos com `is_active=true`.

## Erros e Observabilidade

- **Error Workflow** dedicado, configurado como `errorWorkflow` em cada sub-workflow (config nativa do n8n) — grava `video_runs.status='erro'` + `error_message`, alerta Telegram com `run_id`/nicho/etapa.
- `retryOnFail` nos nodes de chamada HTTP externa (OpenRouter, Pexels, Pixabay, render-service, whisper-service).
- Sub-workflow `Cleanup` (cron semanal) apaga arquivos antigos de `render-service`/áudio intermediário — disco de 200GB não é infinito.
- `dry_run` por nicho pra validar qualidade antes de publicar de verdade.

## Build e Deploy

- Cada workflow = 1 arquivo JSON em `n8n-workflows/*.json`, versionado no repo.
- Criação/atualização via API REST do n8n (`POST`/`PATCH /api/v1/workflows`, header `X-N8N-API-KEY`) — sem passo manual de import.
- Credenciais: YouTube OAuth já existe (criada manualmente, obrigatório por causa do fluxo OAuth via navegador). As demais (OpenRouter, Pexels, Pixabay, Telegram, Postgres, Bearer render-service/whisper-service) são criadas via `POST /api/v1/credentials` no momento da implementação, usando os valores que o usuário fornecer pontualmente — nunca gravados em arquivo versionado.

## Verificação

Cada sub-workflow testado isolado via `execute_workflow` (MCP) com `run_id` de teste pré-populado:

1. Roteiro sozinho — confere `script_text` e tom da persona.
2. Voz sozinho — confere mp3 gerado.
3. Legenda sozinho — confere integração com `voice_url` real do run de teste (contrato já validado no smoke test do whisper-service).
4. Assets sozinho — confere clipes/música batem com o tema.
5. Render sozinho — confere thumbnail com mascote (contrato já validado no smoke test do render-service).
6. Pipeline completo com `dry_run=true` — roda tudo, para antes do YouTube, revisão manual do vídeo final.
7. 1 run real com `dry_run=false` e `approval_mode=manual` — aprovar via Telegram, confirmar publicação no YouTube (`made_for_kids=true`).

## Fora de Escopo (neste plano)

- TikTok/Instagram (fase 2, já registrado no design macro).
- Múltiplos nichos simultâneos (MVP = 1 nicho).
- `approval_mode=auto` (MVP fica manual; ligar automático é mudança de config depois de validar qualidade).
