# Automação Shopee Afiliados (n8n + Gemini + Telegram)

## O que tem pronto
| Workflow | O que faz |
|---|---|
| 01 Achadinhos automático | A cada 3h: busca ofertas, filtra (nota, desconto, comissão, vendas), evita repetidos e entrega ao 06 |
| 02 Post manual por link | Formulário: cola o link de um produto e entrega ao 06 |
| 03 Relatório | 21h no seu Telegram: vendas 24h/7 dias, por canal, mais vendidos e mais lucrativos |
| 04 Alerta de erro | Avisa no seu Telegram quando algum workflow falhar |
| 05 Canva gerar arte | Sub-workflow: foto do produto > template Canva > JPG pronto |
| 07 Saúde dos tokens | 9h: avisa no Telegram se o token do Instagram/Pinterest vence em até 7 dias ou foi recusado |
| 06 Publicar em todos os canais | Gemini escreve o texto, gera 1 link por canal e publica em Telegram, Instagram, Pinterest e TikTok |

Cada canal usa um subId no link (tg, ig, pin, tt): é assim que o relatório sabe qual canal vendeu.

## Canva (precisa de ajuste seu)
- Crie 3 templates de marca (Instagram 4:5, Pinterest 2:3, TikTok 9:16) com campos **titulo, preco, desconto** (texto) e **foto** (imagem), coloque os IDs no `.env` e use `CANVA_ENABLED=true`.
- No workflow 05, selecione a sua credencial OAuth2 do Canva nos nós "Canva - ...".
- A API de autofill do Canva pode exigir plano Enterprise. Sem ele, deixe `CANVA_ENABLED=false`: tudo funciona com a foto do produto.

## Limites por rede
- **Instagram:** conta Business/Criador ligada a Página; token de longa duração expira (~60 dias). Link na legenda não é clicável (por isso o `BIO_LINK`).
- **Pinterest:** token expira (~30 dias); contas novas podem ter acesso limitado a "trial".
- **TikTok:** a postagem automática exige app auditado e domínio verificado. Por padrão o 06 envia a arte + legenda + link no seu Telegram para você postar em 30 segundos. O nó de API existe, desativado.
- **Cliques:** não consegui confirmar que a API de afiliados traga cliques; o relatório traz vendas, itens e comissão por canal e avisa para ver cliques no painel da Shopee.

## Passo a passo no outro computador
1. Copie esta pasta inteira. Requisito: Docker.
2. Renomeie `.env.example` para `.env` e preencha (comentários dizem onde pegar cada chave):
   - Shopee: App ID e Secret (Central de Afiliados > API de Afiliados)
   - Gemini: chave no Google AI Studio
   - Telegram: bot no @BotFather, adicione o bot como **administrador** do canal; pegue seu chat id no @userinfobot
3. Suba:
   ```
   docker compose up -d
   ```
4. Abra http://localhost:5678, crie o usuário dono. Os 7 workflows já estarão importados (inativos).
5. Teste: com `DRY_RUN=true` (padrão) abra o 01 e clique em **Teste manual**. Nada é publicado: você recebe no Telegram pessoal uma prévia de cada post (Telegram, Instagram, Pinterest, TikTok). Quando estiver boa, ponha `DRY_RUN=false` no `.env` e rode `docker compose up -d`.
6. Ative (toggle) os workflows 01, 02, 03, 04 e 07 (05 e 06 são chamados pelos outros e não precisam de toggle). Em 01, 02 e 03: Settings > Error workflow > "04 - Alerta de erro".
7. Ajustes de curadoria (palavras-chave, mínimos, quantos posts por rodada): edite `.env` e rode `docker compose up -d` de novo.

## Pontos de atenção
- **Não foi testado contra a API real** (não tenho suas chaves). Se a Shopee recusar algum campo, o erro aparece no nó com a mensagem da API; corrija a query no nó "Shopee - buscar ofertas" usando o playground da Shopee. O mais provável de ajustar é o relatório (workflow 03).
- A API de afiliados só devolve produtos do programa; link de produto fora dele dá erro no workflow 02.
- Repetidos: a lista de já postados fica em arquivo no volume do n8n (`posted.json`), vale também para execução manual, exceto em modo teste. Se o Code node não conseguir gravar arquivo, usa só a memória do workflow ativo.
- Mantive o aviso de afiliado e sem urgência falsa nas legendas, por regras da Shopee e das plataformas.
- WhatsApp: não incluído; dá para acrescentar depois um nó no workflow 06.
- Instagram, Pinterest e Canva também não foram testados com contas reais: no primeiro teste, rode o 02 com um produto e confira cada canal.
- Segurança: não exponha a porta 5678 na internet sem senha/HTTPS.

## Para pedir ajuda ao Gemini
Cole no Gemini o erro do nó e diga: "Estou usando n8n com a API GraphQL de afiliados da Shopee; ajuste esta query/código".

## Regenerar os workflows
`node build/build.js` recria a pasta `workflows` (edite os códigos em `build/build.js`).
