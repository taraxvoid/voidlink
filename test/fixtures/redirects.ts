import type { Redirects } from '../../src/types'

export default {
    'short.example': {
        cv: { to: 'https://home.example/cv', public: true, title: 'CV' },
        gh: 'https://github.com/example',
    },
    'other.example': {
        talk: 'https://slides.example/talk',
    },
} satisfies Redirects
