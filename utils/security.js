export const RegexCheck = {
    // Only allow alphabetical characters (from any alphabet), numbers, spaces and the characters ".-_@" (minimum 3 characters, maximum 20 characters)
    username: async (username) => {
        return (/^[\p{L}\p{N} .\-@_]{3,20}$/u.test(username));
    },
}