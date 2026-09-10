// The platform merges this object over its own defaults with a shallow
// spread, so a key set here replaces the default wholesale. That is why
// the CSS mock from the defaults is repeated in moduleNameMapper.
module.exports = {
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '\\.(css|less)$': '<rootDir>/jest.identity.mock.js',
    },
    testEnvironment: 'jsdom',
}
