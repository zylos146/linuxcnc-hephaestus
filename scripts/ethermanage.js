const util = require('util');
const exec = util.promisify(require('child_process').exec);

const typeOverride = {
  'type 080e': 'uint16'
}

const decodeSDOBlock = (text) => {
  let sdoList = []
  let sdoRegex = new RegExp(/\s\s0x([a-z\d]{4}):([a-z\d]{2}),[^,]+,([^,]+),[^,]+,\s"([^"]+)"/gm)

  while (!!(match = sdoRegex.exec(text))) {
    const [fullMatch, offset, subOffset, type, desc] = match

    if (desc.includes('SubIndex')) {
      continue
    }

    // Catch any unrecognized types and default them to uint8 so we can proceed
    let realType = type.replace(' ', '')
    if (realType.includes('type')) { // Presence of 'type' indicates unknown type
      realType = typeOverride[realType] || 'uint8'
    }

    sdoList.push({
      offset, subOffset, desc, type: realType
    })
  }

  return sdoList
}

const readSDOBlocks = async (slaveId, sdoIndex) => {
  let grepLimit = sdoIndex ? `| grep ${sdoIndex}` : ''
  const { stdout, stderr } = await exec(`ethercat sdos -p ${slaveId} ${grepLimit}`);

  let blocks = []
  let titleRegex = new RegExp(/SDO\s0x([a-z\d]{4}),\s"([^"]+)"/gm)
  let match
  while (!!(match = titleRegex.exec(stdout))) {
    blocks.push({ startIndex: match.index, sdoIndex: match[1], title: match[2] })
   // console.log(`Found block starting @ ${match.index} for ${match[1]}`)
  }

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    blocks[blockIndex].endIndex = blocks[blockIndex + 1]?.startIndex || -1
  }

  for (const block of blocks) {
    const { startIndex, endIndex } = block
    const blockText = stdout.slice(startIndex, endIndex)

    //console.log(`Found Block ${startIndex}: ${blockText}`)
    block.subindexes = decodeSDOBlock(blockText)
  }

  return blocks
}

const main = async (args) => {
  let filterIndexes = []
  if (args.options.index instanceof Array) {
    filterIndexes = args.options.index
  } else {
    filterIndexes = [args.options.index]
  }

  const { slaveId } = args
  const blocks = await readSDOBlocks(slaveId)

  for (const block of blocks) {
    if (filterIndexes.length > 0 && !filterIndexes.includes(block.sdoIndex) && !filterIndexes.includes('0x' + block.sdoIndex)) {
      //console.log(`Filtering block ${block.sdoIndex} ${block.title}`)
      continue
    }

    if (block.subindexes.length == 0) {
      console.log(`Skipping block ${block.sdoIndex} ${block.title} due to no known subindexes`)
      continue
    }

    //console.log(block)

    let structured = []
    for (const {offset, subOffset, desc, type} of block.subindexes) {
      try {
        const { stdout, stderr } = await exec(`ethercat upload -p ${slaveId} 0x${offset} 0x${subOffset} --type ${type}`);

        let value = stdout.replace('\n', '').replace(/[\u0000-\u001F\u007F-\u009F]/g, "")

        structured.push({
          offset: `0x${offset} 0x${subOffset}`, type, value, desc
        })
      } catch (err) {
        if (err?.message?.includes('Error: Command failed')) {
          console.log(`Unknown failure when looking up ${offset}:${subOffset}\n ${err.message}`)
        }

        if (err?.message?.includes('SDO transfer aborted with code')) {
          let test = err.message.split('\n')

          structured.push({
            offset: `0x${offset} 0x${subOffset}`, type, value: test[1], desc
          })

          continue
        }

        console.log(`Unknown failure: ${err.message}`)
        continue
      }
    }

    console.log(`\n~~  Slave ${slaveId} [${block.sdoIndex}] ${block.title}  ~~`)
    console.table(structured)
  }
}

const vorpal = require('vorpal')();
 
vorpal
  .command('sdo view <slaveId>', 'Views a specific SDO index and it\'s subindex values')
  .option('-i, --index <sdoIndex>', 'Index to view')
  .types({
    string: ['i', 'sdoIndex']
  })
  .action(main);
 
vorpal.parse(process.argv);