// Counts the sound banks a page sends to a SpessaSynth worklet: every
// `addSoundBank` message posted on a MessagePort (the worklet node's port,
// through which spessasynth_lib sends a bank to its processor). A load that
// really runs again sends the bank again; one that hands back an earlier,
// already settled attempt sends nothing, so the count tells the two apart
// where the page's own messages cannot.
//
// Installed on the live page (again after every navigation); returns a
// function that reads the count.
export async function countBankSends(page) {
  await page.evaluate(() => {
    if (Number.isInteger(window.bankSends)) return;
    window.bankSends = 0;
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, ...rest) {
      if (message?.type === 'soundBankManager' && message?.data?.type === 'addSoundBank') window.bankSends += 1;
      return post.call(this, message, ...rest);
    };
  });
  return () => page.evaluate(() => window.bankSends);
}
