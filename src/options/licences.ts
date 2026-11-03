// The open-source packages the extension ships (Settings → About): every runtime dependency of package.json, with its
// licence. A unit test keeps this list in step with package.json.
export const LICENCES: Array<{ name: string; licence: string; url: string }> = [
  { name: 'puppeteer-core', licence: 'Apache-2.0', url: 'https://github.com/puppeteer/puppeteer' },
  { name: 'react', licence: 'MIT', url: 'https://github.com/facebook/react' },
  { name: 'react-dom', licence: 'MIT', url: 'https://github.com/facebook/react' },
  { name: 'react-markdown', licence: 'MIT', url: 'https://github.com/remarkjs/react-markdown' },
  { name: 'rehype-sanitize', licence: 'MIT', url: 'https://github.com/rehypejs/rehype-sanitize' },
  { name: 'remark-gfm', licence: 'MIT', url: 'https://github.com/remarkjs/remark-gfm' },
  { name: 'zod', licence: 'MIT', url: 'https://github.com/colinhacks/zod' },
];
