import * as core from '@actions/core'

/**
 * @type {string} - unformatted message
 */
const unformattedSpellMsg = process.env.SPELL_MESSAGE


/**
 * Takes JSON and formats for GitHub pull request comment
 * @returns {string}
 */
function formatSpell(){
    let spellMsg = "";
    try{

        
    } catch (e) {
        core.error(`Unable to format spell message ${e}`)
    } finally {
        return spellMsg
    }
}


try{
    const formatSpellMsg = formatSpell()

    const formattedMessage = formatSpellMsg

    core.setOutput("FORMATTED_MESSAGE",formattedMessage)
} catch (e) {
    core.error(`Unable to format message: ${e}`)
}