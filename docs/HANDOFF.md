# Handoff — status por funcionalidade

Última verificação: 2026-09-16. Base: 281 testes (25 arquivos), `tsc --noEmit` limpo, `next build` OK.

## 1. Implementado e verificado com dados reais

| Área | Evidência |
|---|---|
| Integração Buffer (somente leitura) | 5 chaves validadas; sync ao vivo de 12 canais; mutations rejeitadas pelo cliente |
| Sincronização idempotente | Re-execuções não duplicam posts nem observações; `markedMissing` só após listagem completa |
| Falha de provedor ≠ fila vazia | Erro 502 real recuperado por retry; testes cobrem falha parcial e paginação interrompida |
| Defeito do Buffer contornado | Filtro com `needs_approval` retorna vazio: consultas separadas + verificação cruzada por `dueAt` |
| Cota compartilhada protegida | Reservas por janela (15 min / dia / 30 dias) e intervalo adaptativo; runs marcados `skipped` |
| Cobertura de fila e alertas | 18 alertas reais criados (fila crítica, vazia, falha de publicação, sync obsoleto), com dedupe e auto-resolução |
| Métricas honestas | `unsupported`, `pending`, `not_reported`, `reported_zero` preservados; seguidores marcados indisponíveis |
| Relatórios semanais pt-BR | 6 relatórios gerados (4 finais, 2 preliminares com motivos por conta); versionamento e snapshot com hash |
| Recomendações com evidência | 12 recomendações reais com amostra, comparação, hipótese rotulada, métrica de sucesso e janela |
| Segurança | Varredura de 21 tabelas / 16.829 linhas sem chave em texto puro; isolamento por marca com 404; auditoria |
| Agendamento serverless | `/api/cron/tick`: 404 sem segredo e com segredo errado, executa jobs com o segredo correto |
| App | 19 rotas; `/portfolio` redireciona sem sessão; download de relatório sem sessão responde 401 |

## 2. Implementado, aguardando ação externa

| Item | O que falta |
|---|---|
| Deploy Vercel + Supabase | Connection string do Supabase e token da Vercel; passo a passo em `docs/DEPLOYMENT.md` |
| Narrativa por IA nos relatórios | `ANTHROPIC_API_KEY` não configurada; hoje as narrativas são determinísticas (funcionam sem IA) |
| Cadência real por conta | Os canais usam horários fixos que não batem com os slots do Buffer; ajuste fino em Settings → Brands |
| Rotação das chaves Buffer | As 5 chaves foram coladas no chat; rotacionar no Buffer e usar Settings → Connections → Rotate key |
| Entrega externa de relatórios (e-mail/Slack) | Fora do escopo inicial: exige destinatários configurados e opt-in explícito |

## 3. Bloqueado por capacidade do provedor

| Item | Motivo |
|---|---|
| Seguidores e crescimento de audiência | O Buffer não expõe audiência (337 tipos verificados); exige conexão direta Instagram/TikTok/YouTube (adiado por decisão do usuário) |
| Impressões, cliques e CTR | Não emitidos para IG/TikTok/YouTube via Buffer |
| Retenção e taxa de conclusão de vídeo | Só tempo médio/total assistido, sem duração do vídeo |
| Pago vs orgânico | Não separável via Buffer |
| Webhooks | Inexistentes: usamos polling com reserva de cota |
| Zeros ambíguos | O Buffer retorna 0 quando a rede não reporta; tratados como `reported_zero` com aviso, nunca como fato |
| Frequência do cron no plano Hobby da Vercel | Hobby executa cron 1×/dia; Pro segue o agendamento declarado |

## 4. Operação

- `npm run worker` (host always-on) **ou** `/api/cron/tick` (Vercel Cron) — equivalentes e seguros em conjunto.
- Scripts: `sync:now`, `reports:run`, `insights:run`, `setup:brands`, `seed:demo`, `connections:import`.
- Runbooks, backup/restore e rotação de chaves: `docs/OPERATIONS.md`.
