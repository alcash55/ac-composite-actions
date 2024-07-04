// Importing the cspell library
const cspell = require('cspell');

// Example array of strings to spell check
const stringsToCheck = [
  'Hello, worlld!',  // intentional typo
  'This is a strign',  // intentional typo
  'Another sentennce'  // intentional typo
];

// Function to perform spell check
async function performSpellCheck(strings) {
  try {
    // Spell check the array of strings
    const result = await cspell.spellCheckStrings(strings);
    
    // Output the results
    console.log('Spell check results:');
    console.log(result.map(r => `${r.text}: ${r.flaggedWords.join(', ')}`).join('\n'));

  } catch (error) {
    console.error('Error occurred during spell check:', error);
  }
}

// Run the function with the array of strings
performSpellCheck(stringsToCheck);
