# Privacy Policy for Nanobrowser

## Introduction

Nanobrowser is a browser-control extension for Chrome and Edge. It lets an agent you run elsewhere — DSH, or any MCP client — work the tabs you are already signed into. This
policy explains what leaves your browser because of the extension, and what does not.

## Open source

Nanobrowser is licensed under the Apache License 2.0. The source code is in the copy you build from, so everything
below can be checked against it.

## Short version

- There is **no Nanobrowser server and no account**. Nothing is sent to the Nanobrowser project.
- The extension stores **only its settings** (interface language, theme, page border, site rules) in your browser.
- It holds **no model and no API key**. The model is the one your DSH profile or your MCP client is configured with.
- Page content reaches the model only when the agent asks to read a page, and only through that client.

## What the extension keeps locally

In `chrome.storage.local`, and nowhere else:

- the interface language, the theme, whether the page border glows, and the site rules you set (a site and Allow, Ask
  or Block).

There is no conversation history, no saved file, no attachment and no key in the extension. Closing it loses nothing
that belongs to you; the conversation lives in DSH.

## What it asks Chrome for

The extension asks Chrome only for what its work needs: reading and driving the page of a task, the side panel, the four
settings above, being told about a navigation, staying connected to the local Hub, drawing the page border, and naming
the group of tabs each task gets. Nothing any permission gives it is sent anywhere; it is all used on your machine.

## What leaves the browser

The extension itself sends nothing anywhere. It answers the Hub running on your own machine (`127.0.0.1`), and the Hub
is what passes a tool call in and a result back.

When the agent reads a page, that page's text — and, if the model can see images, a screenshot of it — reaches the model
your client is configured with. The extension does not choose that model and does not add anything to what it sends.

- **Passwords, payment-card numbers and one-time codes** are masked wherever page content is returned to the model.
- **Payments, access grants, secret input and page `prompt` dialogs** are your own step in every mode: the agent does not
  type them.
- **Submit, send, delete and upload** wait for a card in the side panel unless you set the mode or the site to allow them.

How the model provider handles what it receives is governed by that provider's own policy, and by the configuration of
the client you use. If your client runs a local model, the data stays on your computer.

## What is never collected

Nanobrowser has no analytics, no crash reporting, no usage counts and no identifier of any kind. Nothing is sent to the
Nanobrowser project or to any third party by this extension.

## Removing your data

Removing the extension in `chrome://extensions` removes its local storage. Your DSH sessions and skills live in your DSH
profile (`~/.dsh/...`) and are removed there.

## Contact

Tell whoever maintains your copy.
