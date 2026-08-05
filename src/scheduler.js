/**
 * Timeline calculation and video scheduling logic for Static Stream.
 */

function getWeekEpoch(date = new Date()) {
  const epoch = new Date(date);
  epoch.setHours(0, 0, 0, 0);
  epoch.setDate(epoch.getDate() - epoch.getDay());
  return epoch;
}

function parseIso8601Duration(isoDuration) {
  if (!isoDuration) {
    return 0;
  }

  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(isoDuration);

  if (!match) {
    return 0;
  }

  const days = Number.parseInt(match[1] || "0", 10);
  const hours = Number.parseInt(match[2] || "0", 10);
  const minutes = Number.parseInt(match[3] || "0", 10);
  const seconds = Number.parseInt(match[4] || "0", 10);

  return (((days * 24) + hours) * 60 * 60) + (minutes * 60) + seconds;
}

function selectThumbnail(thumbnails = {}) {
  return (
    thumbnails.maxres?.url ||
    thumbnails.standard?.url ||
    thumbnails.high?.url ||
    thumbnails.medium?.url ||
    thumbnails.default?.url ||
    ""
  );
}

function sortVideosByPublishedAt(videos) {
  return [...videos].sort((left, right) => {
    const leftTime = new Date(left.publishedAt || 0).getTime();
    const rightTime = new Date(right.publishedAt || 0).getTime();
    return rightTime - leftTime;
  });
}

function shuffleArray(items) {
  const shuffledItems = [...items];

  for (let index = shuffledItems.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffledItems[index], shuffledItems[swapIndex]] = [
      shuffledItems[swapIndex],
      shuffledItems[index],
    ];
  }

  return shuffledItems;
}

function selectDailyRotation(channelVideos, recentCount = 2, randomCount = 3) {
  const sortedVideos = sortVideosByPublishedAt(channelVideos);
  const newestVideos = sortedVideos.slice(0, recentCount);
  const rerunPool = sortedVideos.slice(recentCount);
  const rerunVideos = shuffleArray(rerunPool).slice(0, randomCount);
  return [...newestVideos, ...rerunVideos];
}

function resolveLiveSlot(videos, liveOffsetSeconds) {
  let runningDuration = 0;

  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index];
    const nextDuration = runningDuration + video.durationSeconds;

    if (liveOffsetSeconds < nextDuration) {
      return {
        currentIndex: index,
        video,
        startSeconds: liveOffsetSeconds - runningDuration,
      };
    }

    runningDuration = nextDuration;
  }

  return {
    currentIndex: 0,
    video: videos[0],
    startSeconds: 0,
  };
}

module.exports = {
  getWeekEpoch,
  parseIso8601Duration,
  selectThumbnail,
  sortVideosByPublishedAt,
  shuffleArray,
  selectDailyRotation,
  resolveLiveSlot,
};
