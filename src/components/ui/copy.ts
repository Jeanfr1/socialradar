/** Canonical microcopy (docs/product/PRODUCT_SPEC.md §5 and §6). Use verbatim. */
export const DEFINITIONS = {
  coverage:
    "Cobertura: o percentual de horários de publicação esperados — com base na programação de posts desta conta — que já têm um post agendado, olhando até o horizonte alvo configurado. 100% significa que todos os horários esperados até esse horizonte estão preenchidos.",
  runway:
    "Autonomia estimada da fila: nossa melhor estimativa de quantos dias de conteúdo agendado ainda restam antes que esta conta fique sem posts na fila. É uma estimativa baseada na programação e na fila atuais — não uma garantia, já que o comportamento de publicação no Buffer pode mudar depois deste cálculo.",
  firstUncovered:
    "Primeiro horário descoberto: a próxima data e hora, de acordo com a programação de posts desta conta, que não tem nenhum post agendado. Tudo antes desse horário está coberto; é aí que a lacuna começa.",
  lastScheduled:
    "Último post agendado: a data do post mais distante no futuro atualmente agendado para esta conta. Um único post muito distante não significa, por si só, que a conta está bem coberta — confira também a Cobertura e o Primeiro horário descoberto.",
  postsNeeded:
    "Posts necessários: quantos posts adicionais você precisaria agendar, na frequência normal de publicação desta conta, para manter a cobertura em 100% até o seu horizonte alvo.",
  fillDeadline:
    "Prazo para preencher a primeira lacuna: agende pelo menos um post antes desta data para evitar um horário descoberto na fila desta conta.",
  erReach:
    "Taxa de engajamento (por alcance): (reações + comentários + compartilhamentos + salvamentos) ÷ alcance deste post. Usada para Instagram e Facebook, onde o alcance é reportado.",
  erViews:
    "Taxa de engajamento (por visualizações): (reações + comentários + compartilhamentos) ÷ visualizações deste post. Usada para TikTok e YouTube Shorts, onde a contagem de visualizações é o denominador mais confiável.",
  na: "Indisponível: esta plataforma não reportou esta métrica para este post. Não é o mesmo que zero — simplesmente não temos dado nenhum sobre ela.",
  ambiguousZero:
    "O 0 exibido aqui significa que a plataforma reportou zero — ou que não reportou esta métrica e o Buffer assume zero por padrão. Nem sempre conseguimos distinguir os dois casos. Trate com cautela um 0 isolado em um post que, no restante, teve atividade; compare com alcance/visualizações para ter contexto.",
  lifetime:
    "Acumulado: valor total acumulado por este post desde que foi publicado, até a última sincronização. Período: a variação das métricas deste post dentro do intervalo de datas que você selecionou acima. Números acumulados só aumentam; números do período dependem do seu filtro.",
  audienceUnavailable:
    "Requer conexão direta com a plataforma: o Buffer não fornece contagem de seguidores ou de inscritos. Para ver o crescimento de audiência aqui, conecte esta marca diretamente ao Instagram, TikTok ou YouTube (em breve).",
  lastSynced:
    "Última sincronização: quando trouxemos dados novos do Buffer para este item com sucesso pela última vez. O Buffer atualiza as métricas aproximadamente uma vez a cada 24 horas, então isso raramente vai dizer 'agora há pouco'.",
  confidence:
    "Confiança: o quanto este achado é consistente e bem amostrado — com base no tamanho da amostra e em quão repetível foi o padrão — e não uma garantia estatística formal.",
  snoozed:
    "Este alerta não voltará a aparecer até o fim do período de adiamento, a menos que a condição subjacente piore (por exemplo, Atenção escalar para Crítico).",
  pending: "Pendente: o Buffer ainda não recebeu as métricas deste post (isso pode levar até ~24h após a publicação).",
  unsupported: "Não suportado: esta métrica nunca fica disponível para esta plataforma via Buffer.",
  notReported: "Não reportado: as métricas deste post foram sincronizadas, mas a plataforma não incluiu esta métrica.",
} as const;

export const STATUS_COPY = {
  healthy: { label: "Saudável", tip: "Saudável: cobertura ≥ o seu limite de atenção (padrão 7 dias); conta conectada e ativa." },
  warning: { label: "Atenção", tip: "Atenção: a cobertura está abaixo do limite de atenção (padrão 7 dias) e igual ou acima do limite crítico (padrão 3 dias)." },
  critical: { label: "Crítico", tip: "Crítico: a cobertura está abaixo do limite crítico (padrão 3 dias)." },
  empty: { label: "Vazio", tip: "Vazio: nenhum post agendado encontrado. Todos os próximos horários estão descobertos." },
  paused: { label: "Pausado", tip: "Pausado: a fila do Buffer está pausada (ou o monitoramento de cadência está pausado). Os posts agendados não serão publicados até que ela seja retomada." },
  disconnected: { label: "Desconectado", tip: "Desconectado: o canal está desconectado do Buffer. Não conseguimos confirmar a fila dele, e nada pode ser publicado até que ele seja reconectado no Buffer." },
  locked: { label: "Bloqueado", tip: "Bloqueado: o Buffer reporta este canal como bloqueado. Verifique o canal no Buffer." },
  unknown: { label: "Desconhecido", tip: "Desconhecido: não conseguimos determinar a cobertura (ainda sem dados de fila, sem cadência de publicação ou configuração inválida)." },
  stale: {
    label: "Desatualizado",
    tip: "Desatualizado: estes dados vêm de uma sincronização mais antiga que a sua janela de desatualização. O status ao lado é o último estado conhecido da fila, não uma medição confirmada.",
  },
} as const;
