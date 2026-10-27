# Passagens — app do monitor

Painel para iPhone/iPad do [monitor de passagens](https://github.com/5zsdw5jd44-ui/ight-monitor)
(repositório privado). É uma página estática publicada pelo GitHub Pages; não
contém chaves.

- **Buscas:** lista, cria, edita, pausa e exclui as buscas de `buscas.toml`.
- **Situação:** saldo da SerpApi, últimas rodadas e ofertas; botões para buscar agora ou testar.
- **Ajustes:** a chave de acesso do GitHub (fine-grained, só para o repositório
  do monitor), guardada apenas no aparelho.

Para ver sem chave, com dados de exemplo: abra a página com `?demo` no fim do endereço.

## Instalar no iPhone/iPad
Abra o endereço do GitHub Pages no Safari → Compartilhar → **Adicionar à Tela de Início**.

## Arquivos
| Arquivo | Função |
|---|---|
| `index.html` | Telas |
| `app.css` | Visual (claro e escuro) |
| `app.js` | Lógica; fala com a API do GitHub; lê e grava `buscas.toml` |
| `manifest.webmanifest`, `icons/` | Ícone e modo app na Tela de Início |

Ao mudar `app.css` ou `app.js`, aumente o `?v=` deles no `index.html` para o
Safari não usar a versão antiga.
