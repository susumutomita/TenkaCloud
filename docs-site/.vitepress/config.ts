import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'TenkaCloud',
  description: 'クラウド技術者のための OSS 競技プラットフォーム',
  lang: 'ja',

  base: '/TenkaCloud/',

  ignoreDeadLinks: [/^http:\/\/localhost/],

  head: [['link', { rel: 'icon', href: '/TenkaCloud/favicon.ico' }]],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'ホーム', link: '/' },
      { text: 'クイックスタート', link: '/quickstart' },
      { text: 'ガイド', link: '/guide/' },
      {
        text: 'リンク',
        items: [
          {
            text: 'GitHub',
            link: 'https://github.com/susumutomita/TenkaCloud',
          },
          {
            text: 'Issues',
            link: 'https://github.com/susumutomita/TenkaCloud/issues',
          },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'はじめに',
          items: [
            { text: 'クイックスタート', link: '/quickstart' },
            { text: 'アーキテクチャ', link: '/guide/architecture' },
          ],
        },
        {
          text: 'セットアップ',
          items: [
            { text: 'Auth0 設定', link: '/guide/auth0-setup' },
            { text: 'LocalStack', link: '/guide/localstack' },
          ],
        },
        {
          text: 'API リファレンス',
          items: [
            { text: 'Tenant API', link: '/guide/api/tenant' },
            { text: 'Problem API', link: '/guide/api/problem' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/susumutomita/TenkaCloud' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024 TenkaCloud',
    },

    search: {
      provider: 'local',
    },

    outline: {
      level: [2, 3],
      label: '目次',
    },

    docFooter: {
      prev: '前のページ',
      next: '次のページ',
    },
  },
});
