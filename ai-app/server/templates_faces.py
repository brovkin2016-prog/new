"""How many people a template clip shows, for the video templates' checks (templates_check.py, templates_discover.py).
OpenCV's YuNet face finder on 5 frames of the cut clip; the frames are doubled first, so a face of a dancer seen at full
height (some 20 pixels in 480×854) is still found."""
import os, subprocess, urllib.request

YUNET = ("https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
         "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx")
_det = []


def detector(folder):
    """The face finder (fetched once into folder); None when it cannot be had — the count is then left out."""
    if not _det:
        try:
            import cv2
            path = os.path.join(folder, "yunet.onnx")
            for url in YUNET:
                if os.path.exists(path):
                    break
                try:
                    urllib.request.urlretrieve(url, path)
                except Exception as e:
                    print("face finder from", url, str(e)[:120], flush=True)
            _det.append(cv2.FaceDetectorYN.create(path, "", (960, 1708), 0.6, 0.3, 50))
        except Exception as e:
            print("no face finder:", str(e)[:200], flush=True)
            _det.append(None)
    return _det[0]


def faces(cut, seconds, folder, keep=None):
    """(people, each frame's count, the biggest face's height as a share of the frame's). People: the most common count
    over the 5 frames (a tie goes to more). keep: a path to save the middle frame to (a JPEG), for a contact sheet."""
    det = detector(folder)
    if det is None:
        return None, [], 0
    import cv2
    counts, tallest = [], 0.0
    for i in range(5):
        img = os.path.join(folder, f"f{i}.png")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(seconds * (i + 0.5) / 5), "-i", cut, "-frames:v", "1", img],
                       capture_output=True)
        im = cv2.imread(img) if os.path.exists(img) else None
        if im is None:
            continue
        if keep and i == 2:
            cv2.imwrite(keep, cv2.resize(im, (180, 320)), [cv2.IMWRITE_JPEG_QUALITY, 80])
        big = cv2.resize(im, (im.shape[1] * 2, im.shape[0] * 2), interpolation=cv2.INTER_CUBIC)
        det.setInputSize((big.shape[1], big.shape[0]))
        _, found = det.detect(big)
        found = [] if found is None else found
        counts.append(len(found))
        for f in found:
            tallest = max(tallest, float(f[3]) / big.shape[0])
        os.remove(img)
    if not counts:
        return None, [], 0
    return max(set(counts), key=lambda n: (counts.count(n), n)), counts, round(tallest, 3)
